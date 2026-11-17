// Package rest implements the GitHub REST v3 API under /api/v3: repositories,
// git refs, branches, commits, contents, labels, issues and pull requests.
//
// Routing is done by hand on the raw path (indexOf / slice, no regex, no
// URL parsing) so the hot paths stay cheap. The two perf workloads that hit
// this package are GET single issue (2000x sequential) and POST issue
// (200x sequential); both parse the path manually and the single-issue GET
// serves pre-serialized bytes cached on the issue at creation time.
//
// Auth and the X-GitHub-Request-Id header are enforced by the server wrapper
// in cmd/forge; this handler assumes the request is already authenticated.
// The viewer login is learned by that wrapper from the first owner segment
// in a path; handlers read it through s.Viewer().
package rest

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"forge/internal/store"
	"forge/internal/util"
)

// Handler returns the REST v3 handler for the given store.
func Handler(s *store.Store) http.HandlerFunc {
	h := &handler{s: s}
	return h.serve
}

type handler struct {
	s *store.Store
}

// reply is a fully built response. Bytes are assembled while the store lock
// is held; serve writes them to the network after the lock is released.
type reply struct {
	status int
	body   []byte
	link   string
	scopes bool
}

func errReply(status int, msg string) reply {
	b, _ := json.Marshal(map[string]string{"message": msg})
	return reply{status: status, body: b}
}

func jsonReply(status int, v any) reply {
	b, err := json.Marshal(v)
	if err != nil {
		return errReply(http.StatusInternalServerError, "encode error")
	}
	return reply{status: status, body: b}
}

func (h *handler) serve(w http.ResponseWriter, r *http.Request) {
	rep := h.dispatch(r)
	if rep.scopes {
		w.Header().Set("X-OAuth-Scopes", "repo")
	}
	if rep.link != "" {
		w.Header().Set("Link", rep.link)
	}
	if rep.status == http.StatusNoContent {
		w.WriteHeader(rep.status)
		return
	}
	util.WriteJSONBytes(w, rep.status, rep.body)
}

// decodeBody decodes one JSON object from the request body. It reports false
// on malformed JSON (the caller then answers 400).
func decodeBody(r *http.Request, v any) bool {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	return dec.Decode(v) == nil
}

// dispatch routes one request. The path arrives as /api/v3... ; rest is the
// part after /api/v3.
func (h *handler) dispatch(r *http.Request) reply {
	p := r.URL.Path
	if len(p) < 7 || p[:7] != "/api/v3" {
		return errReply(http.StatusNotFound, "Not Found")
	}
	rest := p[7:]

	// Hot path first: GET /repos/{owner}/{repo}/issues/{n} is the read
	// workload (2000x sequential). Manual parse, no allocation beyond the
	// map key inside getSingleIssue.
	if r.Method == http.MethodGet {
		if n, owner, name, ok := parseSingleIssue(rest); ok {
			return h.getSingleIssue(owner, name, n)
		}
	}

	switch {
	case rest == "" || rest == "/":
		if r.Method == http.MethodGet {
			return reply{status: http.StatusOK, body: []byte(`{"current_user_url":"/api/v3/user"}`), scopes: true}
		}
	case rest == "/meta":
		if r.Method == http.MethodGet {
			return reply{status: http.StatusOK, body: []byte(`{"installed_version":"1.0.0"}`)}
		}
	case rest == "/user":
		if r.Method == http.MethodGet {
			return jsonReply(http.StatusOK, ownerOut{Login: h.s.Viewer()})
		}
	case rest == "/user/repos":
		if r.Method == http.MethodGet {
			return h.listUserRepos(r)
		}
		if r.Method == http.MethodPost {
			return h.createRepo(r)
		}
	default:
		if owner, name, tail, ok := parseReposPath(rest); ok {
			return h.dispatchRepo(r, owner, name, tail)
		}
	}
	return errReply(http.StatusNotFound, "Not Found")
}

// parseSingleIssue matches "/repos/{owner}/{repo}/issues/{digits}" exactly
// and returns the issue number plus owner and repo. Anything else (list,
// comments, a non-numeric tail) reports not-ok so the caller falls through
// to the general router.
func parseSingleIssue(rest string) (n int, owner, name string, ok bool) {
	i := strings.Index(rest, "/issues/")
	if i < 0 {
		return 0, "", "", false
	}
	head := rest[:i]
	if len(head) < 8 || head[:7] != "/repos/" {
		return 0, "", "", false
	}
	seg := head[7:]
	j := strings.IndexByte(seg, '/')
	if j <= 0 {
		return 0, "", "", false
	}
	owner = seg[:j]
	name = seg[j+1:]
	if name == "" || strings.IndexByte(name, '/') >= 0 {
		return 0, "", "", false
	}
	numStr := rest[i+8:]
	if numStr == "" {
		return 0, "", "", false
	}
	for k := 0; k < len(numStr); k++ {
		if numStr[k] < '0' || numStr[k] > '9' {
			return 0, "", "", false
		}
	}
	n, _ = strconv.Atoi(numStr)
	return n, owner, name, true
}

// parseReposPath splits "/repos/{owner}/{repo}" + tail into its parts.
func parseReposPath(rest string) (owner, name, tail string, ok bool) {
	if len(rest) < 8 || rest[:7] != "/repos/" {
		return "", "", "", false
	}
	seg := rest[7:]
	i := strings.IndexByte(seg, '/')
	if i <= 0 {
		return "", "", "", false
	}
	owner = seg[:i]
	seg = seg[i+1:]
	if j := strings.IndexByte(seg, '/'); j < 0 {
		name, tail = seg, ""
	} else {
		name, tail = seg[:j], seg[j:]
	}
	if name == "" {
		return "", "", "", false
	}
	return owner, name, tail, true
}

// dispatchRepo routes everything under /repos/{owner}/{repo}.
func (h *handler) dispatchRepo(r *http.Request, owner, name, tail string) reply {
	switch {
	case tail == "":
		switch r.Method {
		case http.MethodGet:
			return h.getRepo(owner, name)
		case http.MethodPatch:
			return h.patchRepo(r, owner, name)
		case http.MethodDelete:
			return h.deleteRepo(owner, name)
		}
	case tail == "/git/refs":
		if r.Method == http.MethodPost {
			return h.createRef(r, owner, name)
		}
	case strings.HasPrefix(tail, "/git/refs/heads/"):
		if r.Method == http.MethodGet {
			return h.getRef(owner, name, tail[len("/git/refs/heads/"):])
		}
	case tail == "/branches":
		if r.Method == http.MethodGet {
			return h.listBranches(owner, name)
		}
	case strings.HasPrefix(tail, "/branches/"):
		if r.Method == http.MethodGet {
			return h.getBranch(owner, name, tail[len("/branches/"):])
		}
	case tail == "/commits":
		if r.Method == http.MethodGet {
			return h.listCommits(r, owner, name)
		}
	case tail == "/contents" || strings.HasPrefix(tail, "/contents/"):
		path := strings.TrimPrefix(tail[len("/contents"):], "/")
		switch r.Method {
		case http.MethodPut:
			return h.putContents(r, owner, name, path)
		case http.MethodGet:
			return h.getContents(r, owner, name, path)
		case http.MethodDelete:
			return h.deleteContents(r, owner, name, path)
		}
	case tail == "/labels":
		if r.Method == http.MethodPost {
			return h.createLabel(r, owner, name)
		}
	case tail == "/issues":
		if r.Method == http.MethodGet {
			return h.listIssues(r, owner, name)
		}
		if r.Method == http.MethodPost {
			return h.createIssue(r, owner, name)
		}
	case strings.HasPrefix(tail, "/issues/"):
		return h.dispatchIssue(r, owner, name, tail[len("/issues/"):])
	case tail == "/pulls":
		if r.Method == http.MethodGet {
			return h.listPulls(r, owner, name)
		}
		if r.Method == http.MethodPost {
			return h.createPull(r, owner, name)
		}
	case strings.HasPrefix(tail, "/pulls/"):
		return h.dispatchPull(r, owner, name, tail[len("/pulls/"):])
	}
	return errReply(http.StatusNotFound, "Not Found")
}

// pageParams reads per_page (default 30, capped at 100) and page (default 1).
func pageParams(r *http.Request) (perPage, page int) {
	perPage, page = 30, 1
	q := r.URL.Query()
	if v := q.Get("per_page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			perPage = n
		}
	}
	if perPage > 100 {
		perPage = 100
	}
	if v := q.Get("page"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			page = n
		}
	}
	return perPage, page
}

// pageSlice clamps a page window into [0, total] and returns the total
// number of pages (at least 1).
func pageSlice(total, perPage, page int) (start, end, pages int) {
	pages = (total + perPage - 1) / perPage
	if pages == 0 {
		pages = 1
	}
	if page < 1 {
		page = 1
	}
	start = (page - 1) * perPage
	if start > total {
		start = total
	}
	end = start + perPage
	if end > total {
		end = total
	}
	return start, end, pages
}

// linkHeader builds the pagination Link header (rel="next" + rel="last") as
// absolute same-origin URLs, preserving the request's other query params.
func linkHeader(r *http.Request, perPage, page, pages int) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	base := scheme + "://" + r.Host + r.URL.Path
	q := r.URL.Query()
	q.Set("per_page", strconv.Itoa(perPage))
	q.Set("page", strconv.Itoa(page+1))
	next := base + "?" + q.Encode()
	q.Set("page", strconv.Itoa(pages))
	last := base + "?" + q.Encode()
	return "<" + next + ">; rel=\"next\", <" + last + ">; rel=\"last\""
}

// --- wire shapes ---

type ownerOut struct {
	Login string `json:"login"`
}

type repoOut struct {
	ID            int       `json:"id"`
	NodeID        string    `json:"node_id"`
	Name          string    `json:"name"`
	FullName      string    `json:"full_name"`
	Owner         *ownerOut `json:"owner"`
	Private       bool      `json:"private"`
	Description   string    `json:"description"`
	DefaultBranch string    `json:"default_branch"`
	CreatedAt     string    `json:"created_at"`
	UpdatedAt     string    `json:"updated_at"`
}

// nodeID is a stable opaque id for a repo / issue / pull request.
func nodeID(kind, owner, name string, number int) string {
	raw := kind + ":" + owner + "/" + name
	if number > 0 {
		raw += "#" + strconv.Itoa(number)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func buildRepoJSON(repo *store.Repo) repoOut {
	return repoOut{
		ID:            repo.DatabaseID,
		NodeID:        nodeID("Repository", repo.Owner, repo.Name, 0),
		Name:          repo.Name,
		FullName:      repo.Owner + "/" + repo.Name,
		Owner:         &ownerOut{Login: repo.Owner},
		Private:       repo.Private,
		Description:   repo.Description,
		DefaultBranch: repo.DefaultBranch,
		CreatedAt:     repo.CreatedAt,
		UpdatedAt:     repo.UpdatedAt,
	}
}

// --- /user/repos ---

func (h *handler) listUserRepos(r *http.Request) reply {
	perPage, page := pageParams(r)
	s := h.s
	s.Mu.RLock()
	viewer := s.ViewerLogin
	if viewer == "" {
		viewer = s.Token
	}
	list := make([]*store.Repo, 0, len(s.Repos))
	for _, repo := range s.Repos {
		if repo.Owner == viewer {
			list = append(list, repo)
		}
	}
	// Creation order (DatabaseID) is stable across pages, so a paginated
	// walk can never repeat or skip a repository. The wire structs are
	// built under the lock so no field is read after it is released.
	sort.Slice(list, func(i, j int) bool { return list[i].DatabaseID < list[j].DatabaseID })
	start, end, pages := pageSlice(len(list), perPage, page)
	out := make([]repoOut, 0, end-start)
	for _, repo := range list[start:end] {
		out = append(out, buildRepoJSON(repo))
	}
	rep := jsonReply(http.StatusOK, out)
	s.Mu.RUnlock()
	if pages > 1 && page < pages {
		rep.link = linkHeader(r, perPage, page, pages)
	}
	return rep
}

type createRepoBody struct {
	Name        string `json:"name"`
	Private     bool   `json:"private"`
	Description string `json:"description"`
}

func (h *handler) createRepo(r *http.Request) reply {
	var body createRepoBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	if body.Name == "" {
		return errReply(http.StatusUnprocessableEntity, "name is required")
	}
	owner := h.s.Viewer()
	s := h.s
	s.Mu.Lock()
	if s.GetRepo(owner, body.Name) != nil {
		s.Mu.Unlock()
		return errReply(http.StatusUnprocessableEntity, "Repository already exists")
	}
	repo := s.CreateRepo(owner, body.Name, body.Private, body.Description)
	out := buildRepoJSON(repo)
	s.Mu.Unlock()
	return jsonReply(http.StatusCreated, out)
}

// --- /repos/{owner}/{repo} ---

func (h *handler) getRepo(owner, name string) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := buildRepoJSON(repo)
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

type patchRepoBody struct {
	Description *string `json:"description"`
	Name        *string `json:"name"`
	Private     *bool   `json:"private"`
}

func (h *handler) patchRepo(r *http.Request, owner, name string) reply {
	var body patchRepoBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if body.Description != nil {
		repo.Description = *body.Description
	}
	if body.Private != nil {
		repo.Private = *body.Private
	}
	if body.Name != nil && *body.Name != "" && *body.Name != name {
		delete(s.Repos, s.Key(owner, name))
		repo.Name = *body.Name
		s.Repos[s.Key(owner, repo.Name)] = repo
	}
	repo.UpdatedAt = util.Now()
	out := buildRepoJSON(repo)
	s.Mu.Unlock()
	return jsonReply(http.StatusOK, out)
}

func (h *handler) deleteRepo(owner, name string) reply {
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	delete(s.Repos, s.Key(owner, name))
	s.Mu.Unlock()
	return reply{status: http.StatusNoContent}
}
