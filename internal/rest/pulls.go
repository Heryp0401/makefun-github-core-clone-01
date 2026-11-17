package rest

import (
	"net/http"
	"strconv"
	"strings"

	"forge/internal/git"
	"forge/internal/store"
	"forge/internal/util"
)

// --- pull requests ---

type pullFileOut struct {
	Filename  string `json:"filename"`
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Changes   int    `json:"changes"`
}

type pullRefOut struct {
	Ref   string `json:"ref"`
	SHA   string `json:"sha"`
	Label string `json:"label,omitempty"`
}

type pullOut struct {
	ID             int        `json:"id"`
	NodeID         string     `json:"node_id"`
	Number         int        `json:"number"`
	Title          string     `json:"title"`
	Body           string     `json:"body"`
	State          string     `json:"state"`
	Head           pullRefOut `json:"head"`
	Base           pullRefOut `json:"base"`
	Merged         bool       `json:"merged"`
	MergedAt       string     `json:"merged_at"`
	MergeCommitSHA string     `json:"merge_commit_sha"`
	Mergeable      string     `json:"mergeable"`
	CreatedAt      string     `json:"created_at"`
	UpdatedAt      string     `json:"updated_at"`
	User           *ownerOut  `json:"user"`
}

func buildPullOut(repo *store.Repo, pr *store.Pull) pullOut {
	return pullOut{
		ID:             repo.DatabaseID*1000000 + 500000 + pr.Number,
		NodeID:         nodeID("PullRequest", repo.Owner, repo.Name, pr.Number),
		Number:         pr.Number,
		Title:          pr.Title,
		Body:           pr.Body,
		State:          pr.State,
		Head:           pullRefOut{Ref: pr.HeadRef, SHA: pr.HeadSHA, Label: repo.Owner + ":" + pr.HeadRef},
		Base:           pullRefOut{Ref: pr.BaseRef, SHA: pr.BaseSHA, Label: repo.Owner + ":" + pr.BaseRef},
		Merged:         pr.Merged,
		MergedAt:       pr.MergedAt,
		MergeCommitSHA: pr.MergeCommitSHA,
		Mergeable:      pr.Mergeable,
		CreatedAt:      util.Now(),
		UpdatedAt:      util.Now(),
		User:           &ownerOut{Login: repo.Owner},
	}
}

// findPull returns the pull request with number n, or nil. Numbers are dense
// from 1 in creation order, so the slice index is the fast path.
func findPull(repo *store.Repo, n int) *store.Pull {
	if n >= 1 && n <= len(repo.Pulls) {
		if pr := repo.Pulls[n-1]; pr.Number == n {
			return pr
		}
	}
	for _, pr := range repo.Pulls {
		if pr.Number == n {
			return pr
		}
	}
	return nil
}

type pullBody struct {
	Head  string `json:"head"`
	Base  string `json:"base"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

func (h *handler) createPull(r *http.Request, owner, name string) reply {
	var body pullBody
	if !decodeBody(r, &body) {
		return errReply(http.StatusBadRequest, "malformed JSON body")
	}
	if body.Title == "" {
		return errReply(http.StatusUnprocessableEntity, "title is required")
	}
	if body.Head == "" || body.Base == "" {
		return errReply(http.StatusUnprocessableEntity, "head and base are required")
	}
	s := h.s
	s.Mu.Lock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	headSHA := repo.Ref("refs/heads/" + body.Head)
	if headSHA == "" {
		s.Mu.Unlock()
		return errReply(http.StatusUnprocessableEntity, "head branch not found")
	}
	baseSHA := repo.Ref("refs/heads/" + body.Base)
	if baseSHA == "" {
		s.Mu.Unlock()
		return errReply(http.StatusUnprocessableEntity, "base branch not found")
	}
	// The changed files are computed once, at creation, from the two trees.
	var files []store.PullFile
	if headObj := repo.GetObject(headSHA); headObj != nil && headObj.Type == "commit" {
		if baseObj := repo.GetObject(baseSHA); baseObj != nil && baseObj.Type == "commit" {
			headTree, _ := git.ParseCommit(headObj.Data)
			baseTree, _ := git.ParseCommit(baseObj.Data)
			files = git.DiffTrees(repo, baseTree, headTree)
		}
	}
	if files == nil {
		files = []store.PullFile{}
	}
	pr := &store.Pull{
		Number:    repo.NextPull,
		Title:     body.Title,
		Body:      body.Body,
		State:     "open",
		HeadRef:   body.Head,
		HeadSHA:   headSHA,
		BaseRef:   body.Base,
		BaseSHA:   baseSHA,
		Mergeable: "MERGEABLE",
		Files:     files,
	}
	repo.NextPull++
	repo.Pulls = append(repo.Pulls, pr)
	out := buildPullOut(repo, pr)
	s.Mu.Unlock()
	return jsonReply(http.StatusCreated, out)
}

func (h *handler) listPulls(r *http.Request, owner, name string) reply {
	q := r.URL.Query()
	state := q.Get("state")
	if state == "" {
		state = "open"
	}
	perPage, page := pageParams(r)
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	filtered := make([]*store.Pull, 0, len(repo.Pulls))
	for _, pr := range repo.Pulls {
		if state == "all" || pr.State == state {
			filtered = append(filtered, pr)
		}
	}
	// Newest first: numbers descend (creation order).
	for i, j := 0, len(filtered)-1; i < j; i, j = i+1, j-1 {
		filtered[i], filtered[j] = filtered[j], filtered[i]
	}
	start, end, pages := pageSlice(len(filtered), perPage, page)
	out := make([]pullOut, 0, end-start)
	for _, pr := range filtered[start:end] {
		out = append(out, buildPullOut(repo, pr))
	}
	rep := jsonReply(http.StatusOK, out)
	if pages > 1 && page < pages {
		rep.link = linkHeader(r, perPage, page, pages)
	}
	s.Mu.RUnlock()
	return rep
}

func (h *handler) getPull(owner, name string, n int) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	pr := findPull(repo, n)
	if pr == nil {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := buildPullOut(repo, pr)
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

func (h *handler) listPullFiles(owner, name string, n int) reply {
	s := h.s
	s.Mu.RLock()
	repo := s.GetRepo(owner, name)
	if repo == nil || repo.Owner != owner {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	pr := findPull(repo, n)
	if pr == nil {
		s.Mu.RUnlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	out := make([]pullFileOut, 0, len(pr.Files))
	for _, f := range pr.Files {
		status := f.Status
		if status == "deleted" {
			status = "removed"
		}
		out = append(out, pullFileOut{
			Filename:  f.Filename,
			Status:    status,
			Additions: f.Additions,
			Deletions: f.Deletions,
			Changes:   f.Changes,
		})
	}
	s.Mu.RUnlock()
	return jsonReply(http.StatusOK, out)
}

// dispatchPull routes /pulls/{n}, /pulls/{n}/files and /pulls/{n}/merge.
func (h *handler) dispatchPull(r *http.Request, owner, name, rest string) reply {
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
		if r.Method == http.MethodGet {
			return h.getPull(owner, name, n)
		}
	case "/files":
		if r.Method == http.MethodGet {
			return h.listPullFiles(owner, name, n)
		}
	case "/merge":
		if r.Method == http.MethodPut {
			return h.mergePull(r, owner, name, n)
		}
	}
	return errReply(http.StatusNotFound, "Not Found")
}

// --- merge (squash) ---

type mergeBody struct {
	MergeMethod string `json:"merge_method"`
}

type mergeOut struct {
	Merged  bool   `json:"merged"`
	SHA     string `json:"sha"`
	Message string `json:"message"`
}

// mergeConflict reports whether squashing this PR onto the current base tip
// would conflict. The merge base is the base commit the PR was opened
// against. A file changed on both sides (base tip vs head) with different
// resulting content — including delete-vs-modify — is a conflict.
func mergeConflict(repo *store.Repo, pr *store.Pull) bool {
	curBaseSHA := repo.Ref("refs/heads/" + pr.BaseRef)
	if curBaseSHA == "" || curBaseSHA == pr.BaseSHA {
		return false
	}
	baseObj := repo.GetObject(pr.BaseSHA)
	headObj := repo.GetObject(pr.HeadSHA)
	curObj := repo.GetObject(curBaseSHA)
	if baseObj == nil || headObj == nil || curObj == nil {
		return false
	}
	baseTree, _ := git.ParseCommit(baseObj.Data)
	headTree, _ := git.ParseCommit(headObj.Data)
	curTree, _ := git.ParseCommit(curObj.Data)
	headDiff := git.DiffTrees(repo, baseTree, headTree)
	curDiff := git.DiffTrees(repo, baseTree, curTree)
	changedOnBase := make(map[string]bool, len(curDiff))
	for _, f := range curDiff {
		changedOnBase[f.Filename] = true
	}
	for _, f := range headDiff {
		if !changedOnBase[f.Filename] {
			continue
		}
		headSHA, _, headOK := git.LookupPath(repo, headTree, f.Filename)
		curSHA, _, curOK := git.LookupPath(repo, curTree, f.Filename)
		if !headOK && !curOK {
			continue
		}
		if headSHA != curSHA {
			return true
		}
	}
	return false
}

func (h *handler) mergePull(r *http.Request, owner, name string, n int) reply {
	var body mergeBody
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
	pr := findPull(repo, n)
	if pr == nil {
		s.Mu.Unlock()
		return errReply(http.StatusNotFound, "Not Found")
	}
	if pr.Merged {
		out := mergeOut{Merged: true, SHA: pr.MergeCommitSHA, Message: "Pull Request successfully merged"}
		s.Mu.Unlock()
		return jsonReply(http.StatusOK, out)
	}
	if pr.State != "open" {
		s.Mu.Unlock()
		return errReply(http.StatusMethodNotAllowed, "pull request is closed")
	}
	if mergeConflict(repo, pr) {
		s.Mu.Unlock()
		return errReply(http.StatusMethodNotAllowed, "merge conflict")
	}
	headObj := repo.GetObject(pr.HeadSHA)
	baseSHA := repo.Ref("refs/heads/" + pr.BaseRef)
	if headObj == nil || headObj.Type != "commit" || baseSHA == "" {
		s.Mu.Unlock()
		return errReply(http.StatusConflict, "cannot merge")
	}
	// Squash: the merge commit carries the head tree on top of the base tip.
	headTree, _ := git.ParseCommit(headObj.Data)
	msg := "Merge pull request #" + strconv.Itoa(pr.Number) + " from " + repo.Owner + "/" + pr.HeadRef
	mergeSHA := git.MakeCommit(repo, headTree, []string{baseSHA}, msg)
	repo.SetRef("refs/heads/"+pr.BaseRef, mergeSHA)
	pr.State = "closed"
	pr.Merged = true
	pr.MergedAt = util.Now()
	pr.MergeCommitSHA = mergeSHA
	out := mergeOut{Merged: true, SHA: mergeSHA, Message: "Pull Request successfully merged"}
	s.Mu.Unlock()
	return jsonReply(http.StatusOK, out)
}
