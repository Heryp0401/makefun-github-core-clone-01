package rest

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"sort"
	"strings"

	"forge/internal/git"
	"forge/internal/store"
)

// --- git refs ---

type shaOut struct {
	SHA string `json:"sha"`
}

type refOut struct {
	Ref    string `json:"ref"`
	Object shaOut `json:"object"`
}

type createRefBody struct {
	Ref string `json:"ref"`
	SHA string `json:"sha"`
}

func (h *handler) createRef(r *http.Request, owner, name string) reply {
	var body createRefBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	if body.Ref == "" || body.SHA == "" {
		return errReply(http.StatusUnprocessableEntity, "ref and sha are required")
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	// Idempotent: creating an existing branch answers 201 with its tip.
	sha := repo.Ref(body.Ref)
	if sha == "" {
		repo.SetRef(body.Ref, body.SHA)
		sha = body.SHA
	}
	out := refOut{Ref: body.Ref, Object: shaOut{SHA: sha}}
	s.Mu.Unlock()
	return jsonReply(http.StatusCreated, out)
}

func (h *handler) getRef(owner, name, branch string) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	sha := repo.Ref("refs/heads/" + branch)
	if sha == "" {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := refOut{Ref: "refs/heads/" + branch, Object: shaOut{SHA: sha}}
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

// --- branches ---

type branchOut struct {
	Name   string `json:"name"`
	Commit shaOut `json:"commit"`
}

func (h *handler) listBranches(owner, name string) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	names := make([]string, 0, len(repo.Refs))
	for ref := range repo.Refs {
		if strings.HasPrefix(ref, "refs/heads/") {
			names = append(names, ref[len("refs/heads/"):])
		}
	}
	sort.Strings(names)
	out := make([]branchOut, 0, len(names))
	for _, b := range names {
		out = append(out, branchOut{Name: b, Commit: shaOut{SHA: repo.Refs["refs/heads/"+b]}})
	}
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

func (h *handler) getBranch(owner, name, branch string) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	sha := repo.Ref("refs/heads/" + branch)
	if sha == "" {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := branchOut{Name: branch, Commit: shaOut{SHA: sha}}
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

// --- commits ---

type commitPersonOut struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type commitDetailOut struct {
	Message   string          `json:"message"`
	Author    commitPersonOut `json:"author"`
	Committer commitPersonOut `json:"committer"`
}

type commitOut struct {
	SHA    string          `json:"sha"`
	Commit commitDetailOut `json:"commit"`
}

// commitMessage extracts the message from raw commit data: everything after
// the blank line that separates headers from the body.
func commitMessage(data []byte) string {
	i := bytes.Index(data, []byte("\n\n"))
	if i < 0 {
		return ""
	}
	return strings.TrimRight(string(data[i+2:]), "\n")
}

// commitAuthor extracts the author name and email from raw commit data.
func commitAuthor(data []byte) commitPersonOut {
	fallback := commitPersonOut{Name: "Heryp0401", Email: "herrylf33@gmail.com"}
	head := data
	if i := bytes.Index(data, []byte("\n\n")); i >= 0 {
		head = data[:i]
	}
	for _, line := range strings.Split(string(head), "\n") {
		if !strings.HasPrefix(line, "author ") {
			continue
		}
		rest := line[len("author "):]
		lt := strings.IndexByte(rest, '<')
		gt := strings.IndexByte(rest, '>')
		if lt < 0 || gt < 0 || gt <= lt {
			return fallback
		}
		return commitPersonOut{
			Name:  strings.TrimSpace(rest[:lt]),
			Email: rest[lt+1 : gt],
		}
	}
	return fallback
}

// walkCommits lists commits newest-first from a starting SHA, following all
// parents, each commit once.
func walkCommits(repo *store.Repo, start string) []commitOut {
	out := make([]commitOut, 0, 16)
	seen := make(map[string]bool)
	stack := []string{}
	if start != "" {
		stack = append(stack, start)
	}
	for len(stack) > 0 {
		sha := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[sha] {
			continue
		}
		seen[sha] = true
		obj := repo.GetObject(sha)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		_, parents := git.ParseCommit(obj.Data)
		out = append(out, commitOut{
			SHA: sha,
			Commit: commitDetailOut{
				Message:   commitMessage(obj.Data),
				Author:    commitAuthor(obj.Data),
				Committer: commitAuthor(obj.Data),
			},
		})
		for i := len(parents) - 1; i >= 0; i-- {
			stack = append(stack, parents[i])
		}
	}
	return out
}

// resolveRef turns a ?sha= / ?ref= value (branch name or raw commit SHA)
// into a commit SHA, or "" when it names nothing.
func resolveRef(repo *store.Repo, value string) string {
	if value == "" {
		return repo.Ref("refs/heads/" + repo.DefaultBranch)
	}
	if sha := repo.Ref("refs/heads/" + value); sha != "" {
		return sha
	}
	if obj := repo.GetObject(value); obj != nil && obj.Type == "commit" {
		return value
	}
	return ""
}

func (h *handler) listCommits(r *http.Request, owner, name string) reply {
	perPage, page := pageParams(r)
	shaParam := r.URL.Query().Get("sha")
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	start := resolveRef(repo, shaParam)
	out := walkCommits(repo, start)
	from, to, pages := pageSlice(len(out), perPage, page)
	out = out[from:to]
	rep := jsonReply(http.StatusOK, out)
	if pages > 1 && page < pages {
		rep.link = linkHeader(r, perPage, page, pages)
	}
	s.Mu.RUnlock()
	return rep
}

// --- contents ---

type contentFileOut struct {
	Type     string `json:"type"`
	Encoding string `json:"encoding,omitempty"`
	Content  string `json:"content,omitempty"`
	SHA      string `json:"sha"`
	Size     int    `json:"size"`
	Name     string `json:"name"`
	Path     string `json:"path"`
}

type dirEntryOut struct {
	Type string `json:"type"`
	Name string `json:"name"`
	Path string `json:"path"`
	SHA  string `json:"sha"`
	Size int    `json:"size"`
}

type commitRefOut struct {
	SHA     string `json:"sha"`
	Message string `json:"message,omitempty"`
}

type contentsPutOut struct {
	Content contentFileOut `json:"content"`
	Commit  commitRefOut   `json:"commit"`
}

type contentsBody struct {
	Message string `json:"message"`
	Content string `json:"content"`
	SHA     string `json:"sha"`
	Branch  string `json:"branch"`
}

// decodeContentBase64 decodes standard base64, ignoring whitespace the way
// the wire contract requires (\r \n \t space).
func decodeContentBase64(s string) ([]byte, error) {
	if strings.ContainsAny(s, " \t\r\n") {
		var b strings.Builder
		b.Grow(len(s))
		for i := 0; i < len(s); i++ {
			c := s[i]
			if c != ' ' && c != '\t' && c != '\r' && c != '\n' {
				b.WriteByte(c)
			}
		}
		s = b.String()
	}
	return base64.StdEncoding.DecodeString(s)
}

func baseName(path string) string {
	if i := strings.LastIndexByte(path, '/'); i >= 0 {
		return path[i+1:]
	}
	return path
}

func isTreeMode(mode string) bool {
	return mode == "40000" || mode == "040000"
}

// headTreeOf returns the tree SHA of a branch tip commit, or "" when the
// branch has no commit yet (unborn).
func headTreeOf(repo *store.Repo, branch string) (headSHA, treeSHA string) {
	headSHA = repo.Ref("refs/heads/" + branch)
	if headSHA == "" {
		return "", ""
	}
	obj := repo.GetObject(headSHA)
	if obj == nil || obj.Type != "commit" {
		return headSHA, ""
	}
	treeSHA, _ = git.ParseCommit(obj.Data)
	return headSHA, treeSHA
}

func (h *handler) putContents(r *http.Request, owner, name, path string) reply {
	var body contentsBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	data, err := decodeContentBase64(body.Content)
	if err != nil {
		return errReply(http.StatusUnprocessableEntity, "content is not valid base64")
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	branch := body.Branch
	if branch == "" {
		branch = repo.DefaultBranch
	}
	refName := "refs/heads/" + branch
	headSHA, headTree := headTreeOf(repo, branch)
	if headSHA == "" && branch != repo.DefaultBranch {
		// Writing to a new branch starts it from the default branch tip.
		headSHA, headTree = headTreeOf(repo, repo.DefaultBranch)
	}
	curSHA, curTyp, found := "", "", false
	if headTree != "" {
		curSHA, curTyp, found = git.LookupPath(repo, headTree, path)
	}
	isUpdate := found
	if found && curTyp == "tree" {
		s.Mu.Unlock()
		return errReply(http.StatusUnprocessableEntity, "path is a directory")
	}
	if found {
		if body.SHA != "" && body.SHA != curSHA {
			s.Mu.Unlock()
			return errReply(http.StatusConflict, "sha does not match the current file")
		}
	} else if body.SHA != "" {
		s.Mu.Unlock()
		return errReply(http.StatusConflict, "sha does not match the current file")
	}
	blobSHA := git.MakeBlob(repo, data)
	newTree := git.UpdateTree(repo, headTree, path, blobSHA)
	msg := body.Message
	if msg == "" {
		msg = "Update " + path
	}
	var parents []string
	if headSHA != "" {
		parents = []string{headSHA}
	}
	commitSHA := git.MakeCommit(repo, newTree, parents, msg)
	repo.SetRef(refName, commitSHA)
	out := contentsPutOut{
		Content: contentFileOut{
			Type:     "file",
			Encoding: "base64",
			Content:  base64.StdEncoding.EncodeToString(data),
			SHA:      blobSHA,
			Size:     len(data),
			Name:     baseName(path),
			Path:     path,
		},
		Commit: commitRefOut{SHA: commitSHA, Message: msg},
	}
	status := http.StatusCreated
	if isUpdate {
		status = http.StatusOK
	}
	s.Mu.Unlock()
	return jsonReply(status, out)
}

func (h *handler) getContents(r *http.Request, owner, name, path string) reply {
	refParam := r.URL.Query().Get("ref")
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	headSHA := resolveRef(repo, refParam)
	if headSHA == "" {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	obj := repo.GetObject(headSHA)
	if obj == nil || obj.Type != "commit" {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	treeSHA, _ := git.ParseCommit(obj.Data)
	if path == "" {
		rep := h.listDir(repo, treeSHA, "")
		s.Mu.RUnlock()
		return rep
	}
	sha, typ, found := git.LookupPath(repo, treeSHA, path)
	if !found {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if typ == "blob" {
		blob := repo.GetObject(sha)
		if blob == nil {
			s.Mu.RUnlock()
			return errReply(http.StatusNotFound, "Not Found")
		}
		out := contentFileOut{
			Type:     "file",
			Encoding: "base64",
			Content:  base64.StdEncoding.EncodeToString(blob.Data),
			SHA:      sha,
			Size:     len(blob.Data),
			Name:     baseName(path),
			Path:     path,
		}
		s.Mu.RUnlock()
		return jsonReply(http.StatusOK, out)
	}
	rep := h.listDir(repo, treeSHA, path)
	s.Mu.RUnlock()
	return rep
}

// listDir renders a directory listing for path ("": the tree root).
// The caller must hold s.Mu with RLock.
func (h *handler) listDir(repo *store.Repo, treeSHA, path string) reply {
	entries := git.ListDir(repo, treeSHA, path)
	out := make([]dirEntryOut, 0, len(entries))
	for _, e := range entries {
		typ := "file"
		size := 0
		if isTreeMode(e.Mode) {
			typ = "dir"
		} else if b := repo.GetObject(e.SHA); b != nil {
			size = len(b.Data)
		}
		p := e.Name
		if path != "" {
			p = path + "/" + e.Name
		}
		out = append(out, dirEntryOut{Type: typ, Name: e.Name, Path: p, SHA: e.SHA, Size: size})
	}
	return jsonReply(http.StatusOK, out)
}

func (h *handler) deleteContents(r *http.Request, owner, name, path string) reply {
	var body contentsBody
	if r.ContentLength != 0 {
		if !decodeBody(r, &body) {
			return errReply(http.StatusBadRequest, "malformed JSON body")
		}
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	branch := body.Branch
	if branch == "" {
		branch = repo.DefaultBranch
	}
	refName := "refs/heads/" + branch
	headSHA, headTree := headTreeOf(repo, branch)
	if headSHA == "" || headTree == "" {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	curSHA, curTyp, found := git.LookupPath(repo, headTree, path)
	if !found {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if curTyp != "blob" {
		s.Mu.Unlock()
		return errReply(http.StatusUnprocessableEntity, "path is a directory")
	}
	if body.SHA != "" && body.SHA != curSHA {
		s.Mu.Unlock()
		return errReply(http.StatusConflict, "sha does not match the current file")
	}
	newTree := git.UpdateTree(repo, headTree, path, "")
	msg := body.Message
	if msg == "" {
		msg = "Delete " + path
	}
	commitSHA := git.MakeCommit(repo, newTree, []string{headSHA}, msg)
	repo.SetRef(refName, commitSHA)
	out := struct {
		Commit commitRefOut `json:"commit"`
	}{Commit: commitRefOut{SHA: commitSHA, Message: msg}}
	s.Mu.Unlock()
	return jsonReply(http.StatusOK, out)
}
