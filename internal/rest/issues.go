package rest

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"forge/internal/store"
	"forge/internal/util"
)

// --- labels ---

type labelOut struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

type labelBody struct {
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (h *handler) createLabel(r *http.Request, owner, name string) reply {
	var body labelBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	if body.Name == "" {
		return errReply(http.StatusUnprocessableEntity, "name is required")
	}
	color := body.Color
	if color == "" {
		color = "ededed"
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if repo.Labels == nil {
		repo.Labels = make(map[string]*store.Label)
	}
	repo.Labels[body.Name] = &store.Label{Name: body.Name, Color: color}
	out := labelOut{Name: body.Name, Color: color}
	s.Mu.Unlock()
	return jsonReply(http.StatusCreated, out)
}

// --- issues ---

type issueOut struct {
	ID        int        `json:"id"`
	NodeID    string     `json:"node_id"`
	Number    int        `json:"number"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	State     string     `json:"state"`
	Labels    []labelOut `json:"labels"`
	Comments  int        `json:"comments"`
	CreatedAt string     `json:"created_at"`
	UpdatedAt string     `json:"updated_at"`
	User      *ownerOut  `json:"user"`
}

// buildIssueOut renders an issue. Labels always serialize as an array,
// never null.
func buildIssueOut(repo *store.Repo, iss *store.Issue) issueOut {
	labels := make([]labelOut, 0, len(iss.Labels))
	for _, n := range iss.Labels {
		color := ""
		if l := repo.Labels[n]; l != nil {
			color = l.Color
		}
		labels = append(labels, labelOut{Name: n, Color: color})
	}
	return issueOut{
		ID:        repo.DatabaseID*1000000 + iss.Number,
		NodeID:    nodeID("Issue", repo.Owner, repo.Name, iss.Number),
		Number:    iss.Number,
		Title:     iss.Title,
		Body:      iss.Body,
		State:     iss.State,
		Labels:    labels,
		Comments:  len(iss.Comments),
		CreatedAt: iss.CreatedAt,
		UpdatedAt: iss.UpdatedAt,
		User:      &ownerOut{Login: repo.Owner},
	}
}

func buildIssueJSON(repo *store.Repo, iss *store.Issue) []byte {
	b, _ := json.Marshal(buildIssueOut(repo, iss))
	return b
}

// cacheIssueJSON (re)builds the issue's cached single-GET bytes. Call it
// under the store Lock after every mutation of the issue.
func cacheIssueJSON(repo *store.Repo, iss *store.Issue) {
	iss.JSON = buildIssueJSON(repo, iss)
}

// findIssue returns the issue with number n, or nil. Issue numbers are dense
// from 1 in creation order, so the slice index is the fast path.
func findIssue(repo *store.Repo, n int) *store.Issue {
	if n >= 1 && n <= len(repo.Issues) {
		if iss := repo.Issues[n-1]; iss.Number == n {
			return iss
		}
	}
	for _, iss := range repo.Issues {
		if iss.Number == n {
			return iss
		}
	}
	return nil
}

type issueBody struct {
	Title  string          `json:"title"`
	Body   string          `json:"body"`
	Labels json.RawMessage `json:"labels"`
}

// parseLabelNames accepts the labels array as plain strings (the REST wire
// form) or as [{name}] objects.
func parseLabelNames(raw json.RawMessage) ([]string, bool) {
	if len(raw) == 0 {
		return nil, true
	}
	var strs []string
	if err := json.Unmarshal(raw, &strs); err == nil {
		return strs, true
	}
	var objs []struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(raw, &objs); err == nil {
		out := make([]string, 0, len(objs))
		for _, o := range objs {
			out = append(out, o.Name)
		}
		return out, true
	}
	return nil, false
}

func (h *handler) createIssue(r *http.Request, owner, name string) reply {
	var body issueBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	if body.Title == "" {
		return errReply(http.StatusUnprocessableEntity, "title is required")
	}
	labelNames, ok := parseLabelNames(body.Labels)
	if !ok {
		return errReply(http.StatusBadRequest, "labels must be an array")
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	// An issue may only carry labels that already exist on the repo.
	for _, ln := range labelNames {
		if _, ok := repo.Labels[ln]; !ok {
			s.Mu.Unlock()
			return errReply(http.StatusUnprocessableEntity, "label does not exist: "+ln)
		}
	}
	iss := &store.Issue{
		Number:    repo.NextIssue,
		Title:     body.Title,
		Body:      body.Body,
		State:     "open",
		Labels:    append([]string{}, labelNames...),
		Comments:  make([]*store.Comment, 0),
		CreatedAt: util.Now(),
		UpdatedAt: util.Now(),
	}
	repo.NextIssue++
	repo.Issues = append(repo.Issues, iss)
	cacheIssueJSON(repo, iss)
	b := iss.JSON
	s.Mu.Unlock()
	return reply{status: http.StatusCreated, body: b}
}

func (h *handler) listIssues(r *http.Request, owner, name string) reply {
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	direction := q.Get("direction")
	if direction == "" {
		direction = "desc"
	}
	perPage, page := pageParams(r)
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	filtered := make([]*store.Issue, 0, len(repo.Issues))
	for _, iss := range repo.Issues {
		if state == "all" || iss.State == state {
			filtered = append(filtered, iss)
		}
	}
	// Created order is number order (all timestamps are the fixed trial
	// time), so sort strictly by number.
	if direction == "asc" {
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Number < filtered[j].Number })
	} else {
		sort.Slice(filtered, func(i, j int) bool { return filtered[i].Number > filtered[j].Number })
	}
	start, end, pages := pageSlice(len(filtered), perPage, page)
	out := make([]issueOut, 0, end-start)
	for _, iss := range filtered[start:end] {
		out = append(out, buildIssueOut(repo, iss))
	}
	rep := jsonReply(http.StatusOK, out)
	if pages > 1 && page < pages {
		rep.link = linkHeader(r, perPage, page, pages)
	}
	s.Mu.RUnlock()
	return rep
}

// getSingleIssue is the read-workload hot path: manual path parsing happens
// in dispatch/parseSingleIssue, and the response is the issue's cached JSON
// bytes, built at creation/mutation time. No per-request marshal, no query
// parsing, no path splitting.
func (h *handler) getSingleIssue(owner, name string, n int) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	iss := findIssue(repo, n)
	if iss == nil {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	b := iss.JSON
	if b == nil {
		// Cache was never populated (should not happen: creation caches
		// it); marshal fresh under the read lock, without storing.
		b = buildIssueJSON(repo, iss)
	}
	s.Mu.RUnlock()
	return reply{status: http.StatusOK, body: b}
}

type patchIssueBody struct {
	State *string `json:"state"`
	Title *string `json:"title"`
	Body  *string `json:"body"`
}

func (h *handler) patchIssue(r *http.Request, owner, name string, n int) reply {
	var body patchIssueBody
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
	iss := findIssue(repo, n)
	if iss == nil {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if body.State != nil && (*body.State == "closed" || *body.State == "open") {
		iss.State = *body.State
	}
	if body.Title != nil {
		iss.Title = *body.Title
	}
	if body.Body != nil {
		iss.Body = *body.Body
	}
	iss.UpdatedAt = util.Now()
	cacheIssueJSON(repo, iss)
	b := iss.JSON
	s.Mu.Unlock()
	return reply{status: http.StatusOK, body: b}
}

// dispatchIssue routes /issues/{n} and /issues/{n}/comments.
func (h *handler) dispatchIssue(r *http.Request, owner, name, rest string) reply {
	i := strings.IndexByte(rest, '/')
	var numStr, sub string
	if i < 0 {
		numStr, sub = rest, ""
	} else {
		numStr, sub = rest[:i], rest[i:]
	}
	n, err := strconv.Atoi(numStr)
	if err != nil || n < 1 {
		return errReply(http.StatusNotFound, "Not Found")
	}
	switch sub {
	case "":
		switch r.Method {
		case http.MethodGet:
			return h.getSingleIssue(owner, name, n)
		case http.MethodPatch:
			return h.patchIssue(r, owner, name, n)
		}
	case "/comments":
		switch r.Method {
		case http.MethodGet:
			return h.listComments(owner, name, n)
		case http.MethodPost:
			return h.createComment(r, owner, name, n)
		}
	}
	return errReply(http.StatusNotFound, "Not Found")
}

// --- comments ---

type commentOut struct {
	ID        int       `json:"id"`
	Body      string    `json:"body"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	User      *ownerOut `json:"user"`
}

type commentBody struct {
	Body string `json:"body"`
}

func buildCommentOut(repo *store.Repo, c *store.Comment) commentOut {
	return commentOut{
		ID:        c.ID,
		Body:      c.Body,
		CreatedAt: c.CreatedAt,
		UpdatedAt: c.UpdatedAt,
		User:      &ownerOut{Login: repo.Owner},
	}
}

func (h *handler) createComment(r *http.Request, owner, name string, n int) reply {
	var body commentBody
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
	iss := findIssue(repo, n)
	if iss == nil {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	c := &store.Comment{
		ID:        repo.NextCommentID,
		Body:      body.Body,
		CreatedAt: util.Now(),
		UpdatedAt: util.Now(),
	}
	repo.NextCommentID++
	iss.Comments = append(iss.Comments, c)
	cacheIssueJSON(repo, iss) // the comments count in the cached JSON changed
	out := buildCommentOut(repo, c)
	s.Mu.Unlock()
	return jsonReply(http.StatusCreated, out)
}

func (h *handler) listComments(owner, name string, n int) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	iss := findIssue(repo, n)
	if iss == nil {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := make([]commentOut, 0, len(iss.Comments))
	for _, c := range iss.Comments {
		out = append(out, buildCommentOut(repo, c))
	}
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}
