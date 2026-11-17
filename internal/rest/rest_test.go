package rest

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"forge/internal/store"
)

// tb is the test-helper interface shared by *testing.T and *testing.B.
type tb interface {
	Helper()
	Fatalf(format string, args ...any)
}

func newTestStore() *store.Store {
	s := store.NewStore("test-token")
	s.LearnViewer("alice")
	return s
}

func doReq(t tb, h http.HandlerFunc, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	r := httptest.NewRequest(method, path, rd)
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	h(w, r)
	return w
}

func mustStatus(t tb, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status = %d, want %d; body = %s", w.Code, want, w.Body.String())
	}
}

func decodeJSON(t tb, w *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(w.Body.Bytes(), v); err != nil {
		t.Fatalf("response is not JSON: %v; body = %s", err, w.Body.String())
	}
}

func createRepo(t tb, h http.HandlerFunc, name string) {
	t.Helper()
	w := doReq(t, h, "POST", "/api/v3/user/repos",
		`{"name":"`+name+`","private":true,"description":"desc `+name+`"}`)
	mustStatus(t, w, http.StatusCreated)
	var repo map[string]any
	decodeJSON(t, w, &repo)
	if repo["name"] != name {
		t.Fatalf("created repo name = %v, want %s", repo["name"], name)
	}
	if repo["default_branch"] == "" {
		t.Fatalf("created repo has no default_branch")
	}
}

// putFile writes a file through PUT /contents and returns the blob sha and
// the commit sha. sha and branch are sent only when non-empty.
func putFile(t tb, h http.HandlerFunc, repo, path, content, sha, branch string) (blobSHA, commitSHA string) {
	t.Helper()
	body := map[string]string{
		"message": "write " + path,
		"content": base64.StdEncoding.EncodeToString([]byte(content)),
	}
	if sha != "" {
		body["sha"] = sha
	}
	if branch != "" {
		body["branch"] = branch
	}
	raw, _ := json.Marshal(body)
	w := doReq(t, h, "PUT", "/api/v3/repos/alice/"+repo+"/contents/"+path, string(raw))
	if w.Code != http.StatusCreated && w.Code != http.StatusOK {
		t.Fatalf("PUT contents %s: status = %d, want 201/200; body = %s", path, w.Code, w.Body.String())
	}
	var out struct {
		Content struct {
			SHA string `json:"sha"`
		} `json:"content"`
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	decodeJSON(t, w, &out)
	return out.Content.SHA, out.Commit.SHA
}

func getFileSHA(t tb, h http.HandlerFunc, repo, path string) string {
	t.Helper()
	w := doReq(t, h, "GET", "/api/v3/repos/alice/"+repo+"/contents/"+path, "")
	mustStatus(t, w, http.StatusOK)
	var out struct {
		SHA string `json:"sha"`
	}
	decodeJSON(t, w, &out)
	return out.SHA
}

func createBranch(t tb, h http.HandlerFunc, repo, branch, sha string) {
	t.Helper()
	w := doReq(t, h, "POST", "/api/v3/repos/alice/"+repo+"/git/refs",
		`{"ref":"refs/heads/`+branch+`","sha":"`+sha+`"}`)
	mustStatus(t, w, http.StatusCreated)
}

func TestRootMetaUser(t *testing.T) {
	h := Handler(newTestStore())
	w := doReq(t, h, "GET", "/api/v3/", "")
	mustStatus(t, w, http.StatusOK)
	if w.Header().Get("X-OAuth-Scopes") == "" {
		t.Fatalf("GET /api/v3/ must carry X-OAuth-Scopes")
	}
	w = doReq(t, h, "GET", "/api/v3/meta", "")
	mustStatus(t, w, http.StatusOK)
	var meta map[string]string
	decodeJSON(t, w, &meta)
	if meta["installed_version"] == "" {
		t.Fatalf("meta installed_version must be non-empty")
	}
	w = doReq(t, h, "GET", "/api/v3/user", "")
	mustStatus(t, w, http.StatusOK)
	var user map[string]string
	decodeJSON(t, w, &user)
	if user["login"] != "alice" {
		t.Fatalf("user login = %q, want alice", user["login"])
	}
}

func TestRepoCRUD(t *testing.T) {
	s := newTestStore()
	h := Handler(s)
	createRepo(t, h, "crud")

	w := doReq(t, h, "GET", "/api/v3/repos/alice/crud", "")
	mustStatus(t, w, http.StatusOK)
	var repo map[string]any
	decodeJSON(t, w, &repo)
	if repo["private"] != true || repo["default_branch"] == "" {
		t.Fatalf("repo read wrong: %v", repo)
	}

	// Foreign owner: 404, never 403.
	w = doReq(t, h, "GET", "/api/v3/repos/mallory/crud", "")
	mustStatus(t, w, http.StatusNotFound)
	var errBody map[string]string
	decodeJSON(t, w, &errBody)
	if errBody["message"] == "" {
		t.Fatalf("404 must carry a message")
	}

	// Missing repo: 404.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/never-created", "")
	mustStatus(t, w, http.StatusNotFound)

	// Patch description.
	w = doReq(t, h, "PATCH", "/api/v3/repos/alice/crud", `{"description":"desc crud (updated)"}`)
	mustStatus(t, w, http.StatusOK)
	decodeJSON(t, w, &repo)
	if repo["description"] != "desc crud (updated)" {
		t.Fatalf("patched description = %v", repo["description"])
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/crud", "")
	decodeJSON(t, w, &repo)
	if repo["description"] != "desc crud (updated)" {
		t.Fatalf("description did not persist: %v", repo["description"])
	}

	// Duplicate create: 422.
	w = doReq(t, h, "POST", "/api/v3/user/repos", `{"name":"crud","private":true}`)
	mustStatus(t, w, http.StatusUnprocessableEntity)

	// Delete, then GET is 404.
	w = doReq(t, h, "DELETE", "/api/v3/repos/alice/crud", "")
	mustStatus(t, w, http.StatusNoContent)
	w = doReq(t, h, "GET", "/api/v3/repos/alice/crud", "")
	mustStatus(t, w, http.StatusNotFound)
}

func TestUserReposPagination(t *testing.T) {
	h := Handler(newTestStore())
	for i := 0; i < 30; i++ {
		createRepo(t, h, "page-"+strconv.Itoa(i))
	}
	seen := map[string]bool{}
	pages := 0
	next := "/api/v3/user/repos?per_page=10"
	for next != "" && pages < 20 {
		w := doReq(t, h, "GET", next, "")
		mustStatus(t, w, http.StatusOK)
		var repos []map[string]any
		decodeJSON(t, w, &repos)
		if len(repos) > 10 {
			t.Fatalf("page has %d repos, want <= 10", len(repos))
		}
		for _, r := range repos {
			name, _ := r["name"].(string)
			if name == "" {
				t.Fatalf("repo without a name on page %d", pages+1)
			}
			if seen[name] {
				t.Fatalf("repo %s repeated across pages", name)
			}
			seen[name] = true
		}
		pages++
		next = ""
		link := w.Header().Get("Link")
		for _, part := range strings.Split(link, ",") {
			if strings.Contains(part, `rel="next"`) {
				start := strings.Index(part, "<")
				end := strings.Index(part, ">")
				if start < 0 || end < 0 {
					t.Fatalf("malformed Link header: %s", link)
				}
				raw := part[start+1 : end]
				// Absolute same-origin URL: strip the origin for the next call.
				if i := strings.Index(raw, "/api/v3/"); i >= 0 {
					next = raw[i:]
				} else {
					next = raw
				}
			}
		}
	}
	if pages < 3 {
		t.Fatalf("pagination produced %d pages, want >= 3", pages)
	}
	if len(seen) != 30 {
		t.Fatalf("pagination reached %d repos, want 30", len(seen))
	}
}

func TestContents(t *testing.T) {
	h := Handler(newTestStore())
	createRepo(t, h, "files")

	// Unborn repo accepts PUT /contents.
	blobSHA, _ := putFile(t, h, "files", "docs/readme.md", "seed content\n", "", "")
	w := doReq(t, h, "GET", "/api/v3/repos/alice/files/contents/docs/readme.md", "")
	mustStatus(t, w, http.StatusOK)
	var file struct {
		Type     string `json:"type"`
		Encoding string `json:"encoding"`
		Content  string `json:"content"`
		SHA      string `json:"sha"`
		Size     int    `json:"size"`
	}
	decodeJSON(t, w, &file)
	if file.Type != "file" || file.Encoding != "base64" {
		t.Fatalf("file shape wrong: %+v", file)
	}
	if file.SHA != blobSHA {
		t.Fatalf("file sha = %s, want %s", file.SHA, blobSHA)
	}
	raw, err := base64.StdEncoding.DecodeString(file.Content)
	if err != nil || string(raw) != "seed content\n" {
		t.Fatalf("file content = %q (err %v)", raw, err)
	}
	if file.Size != len("seed content\n") {
		t.Fatalf("file size = %d", file.Size)
	}

	// Update with the current sha: 200, blob sha changes.
	blobSHA2, _ := putFile(t, h, "files", "docs/readme.md", "updated content\n", blobSHA, "")
	if blobSHA2 == blobSHA {
		t.Fatalf("update did not change the blob sha")
	}

	// Stale sha: 409.
	raw2, _ := json.Marshal(map[string]string{
		"message": "stale",
		"content": base64.StdEncoding.EncodeToString([]byte("stale\n")),
		"sha":     blobSHA,
	})
	w = doReq(t, h, "PUT", "/api/v3/repos/alice/files/contents/docs/readme.md", string(raw2))
	mustStatus(t, w, http.StatusConflict)

	// Directory listing.
	putFile(t, h, "files", "docs/one.txt", "one\n", "", "")
	putFile(t, h, "files", "docs/two.txt", "two\n", "", "")
	w = doReq(t, h, "GET", "/api/v3/repos/alice/files/contents/docs", "")
	mustStatus(t, w, http.StatusOK)
	var entries []map[string]any
	decodeJSON(t, w, &entries)
	names := map[string]bool{}
	for _, e := range entries {
		names[e["name"].(string)] = true
	}
	for _, want := range []string{"readme.md", "one.txt", "two.txt"} {
		if !names[want] {
			t.Fatalf("dir listing misses %s: %v", want, names)
		}
	}

	// Delete, then GET is 404.
	sha := getFileSHA(t, h, "files", "docs/two.txt")
	delBody, _ := json.Marshal(map[string]string{"message": "rm", "sha": sha})
	w = doReq(t, h, "DELETE", "/api/v3/repos/alice/files/contents/docs/two.txt", string(delBody))
	mustStatus(t, w, http.StatusOK)
	var delOut struct {
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	decodeJSON(t, w, &delOut)
	if len(delOut.Commit.SHA) != 40 {
		t.Fatalf("delete commit sha = %q", delOut.Commit.SHA)
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/files/contents/docs/two.txt", "")
	mustStatus(t, w, http.StatusNotFound)

	// Missing file: 404.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/files/contents/nope.txt", "")
	mustStatus(t, w, http.StatusNotFound)
}

func TestBranchesAndCommits(t *testing.T) {
	h := Handler(newTestStore())
	createRepo(t, h, "br")
	_, first := putFile(t, h, "br", "docs/readme.md", "seed\n", "", "")
	createBranch(t, h, "br", "feature-x", first)

	w := doReq(t, h, "GET", "/api/v3/repos/alice/br/branches", "")
	mustStatus(t, w, http.StatusOK)
	var branches []struct {
		Name   string `json:"name"`
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	decodeJSON(t, w, &branches)
	byName := map[string]string{}
	for _, b := range branches {
		byName[b.Name] = b.Commit.SHA
	}
	if byName["main"] != first {
		t.Fatalf("main branch sha = %q, want %s", byName["main"], first)
	}
	if byName["feature-x"] != first {
		t.Fatalf("feature branch sha = %q, want %s", byName["feature-x"], first)
	}

	// One commit on the branch; it shows on the branch list, not on main.
	putFile(t, h, "br", "docs/readme-x.md", "branch file\n", "", "feature-x")
	w = doReq(t, h, "GET", "/api/v3/repos/alice/br/commits?sha=feature-x", "")
	mustStatus(t, w, http.StatusOK)
	var commits []struct {
		SHA    string `json:"sha"`
		Commit struct {
			Message string `json:"message"`
		} `json:"commit"`
	}
	decodeJSON(t, w, &commits)
	if len(commits) == 0 {
		t.Fatalf("no commits on feature-x")
	}
	if commits[0].Commit.Message != "write docs/readme-x.md" {
		t.Fatalf("branch tip message = %q", commits[0].Commit.Message)
	}
	branchTip := commits[0].SHA

	w = doReq(t, h, "GET", "/api/v3/repos/alice/br/commits", "")
	mustStatus(t, w, http.StatusOK)
	decodeJSON(t, w, &commits)
	for _, c := range commits {
		if c.SHA == branchTip {
			t.Fatalf("default branch list must not contain the branch-only commit")
		}
	}

	// Single branch read.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/br/branches/feature-x", "")
	mustStatus(t, w, http.StatusOK)
	var one struct {
		Name   string `json:"name"`
		Commit struct {
			SHA string `json:"sha"`
		} `json:"commit"`
	}
	decodeJSON(t, w, &one)
	if one.Commit.SHA != branchTip {
		t.Fatalf("branch read sha = %q, want %s", one.Commit.SHA, branchTip)
	}
}

func setupIssueRepo(t tb, h http.HandlerFunc, repo string) {
	t.Helper()
	createRepo(t, h, repo)
	putFile(t, h, repo, "docs/readme.md", "seed\n", "", "")
	w := doReq(t, h, "POST", "/api/v3/repos/alice/"+repo+"/labels",
		`{"name":"bug","color":"ededed"}`)
	mustStatus(t, w, http.StatusCreated)
}

func createIssue(t tb, h http.HandlerFunc, repo, title string, labels []string) int {
	t.Helper()
	body := map[string]any{"title": title, "body": "body of " + title}
	if labels != nil {
		body["labels"] = labels
	}
	raw, _ := json.Marshal(body)
	w := doReq(t, h, "POST", "/api/v3/repos/alice/"+repo+"/issues", string(raw))
	mustStatus(t, w, http.StatusCreated)
	var iss struct {
		Number int    `json:"number"`
		Title  string `json:"title"`
		Body   string `json:"body"`
		State  string `json:"state"`
	}
	decodeJSON(t, w, &iss)
	if iss.Title != title || iss.Body != "body of "+title || iss.State != "open" {
		t.Fatalf("issue echo wrong: %+v", iss)
	}
	return iss.Number
}

func TestIssues(t *testing.T) {
	h := Handler(newTestStore())
	setupIssueRepo(t, h, "iss")

	// Unknown label: 422.
	raw, _ := json.Marshal(map[string]any{"title": "x", "body": "y", "labels": []string{"bug-not-a-label"}})
	w := doReq(t, h, "POST", "/api/v3/repos/alice/iss/issues", string(raw))
	mustStatus(t, w, http.StatusUnprocessableEntity)

	n1 := createIssue(t, h, "iss", "first issue", []string{"bug"})
	n2 := createIssue(t, h, "iss", "second issue", nil)
	if n2 != n1+1 {
		t.Fatalf("issue numbers: %d then %d, want +1", n1, n2)
	}
	n3 := createIssue(t, h, "iss", "third issue", nil)

	// Labels echoed on the issue.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n1), "")
	mustStatus(t, w, http.StatusOK)
	var one struct {
		Number int `json:"number"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
	}
	decodeJSON(t, w, &one)
	if len(one.Labels) != 1 || one.Labels[0].Name != "bug" {
		t.Fatalf("issue labels = %+v, want [bug]", one.Labels)
	}

	// Close n2, then list-open excludes it.
	w = doReq(t, h, "PATCH", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n2), `{"state":"closed"}`)
	mustStatus(t, w, http.StatusOK)
	var patched struct {
		State string `json:"state"`
	}
	decodeJSON(t, w, &patched)
	if patched.State != "closed" {
		t.Fatalf("patch state = %q", patched.State)
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n2), "")
	decodeJSON(t, w, &patched)
	if patched.State != "closed" {
		t.Fatalf("closed state did not persist")
	}

	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues?state=open&per_page=100", "")
	mustStatus(t, w, http.StatusOK)
	var list []struct {
		Number int    `json:"number"`
		State  string `json:"state"`
	}
	decodeJSON(t, w, &list)
	for _, iss := range list {
		if iss.State != "open" {
			t.Fatalf("open list contains a %s issue", iss.State)
		}
		if iss.Number == n2 {
			t.Fatalf("open list contains the closed issue")
		}
	}

	// Sort asc / desc strictly.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues?state=open&sort=created&direction=asc&per_page=100", "")
	decodeJSON(t, w, &list)
	pos := map[int]int{}
	for i, iss := range list {
		pos[iss.Number] = i
	}
	if !(pos[n1] < pos[n3]) {
		t.Fatalf("asc order wrong: %v", pos)
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues?state=open&sort=created&direction=desc&per_page=100", "")
	decodeJSON(t, w, &list)
	pos = map[int]int{}
	for i, iss := range list {
		pos[iss.Number] = i
	}
	if !(pos[n3] < pos[n1]) {
		t.Fatalf("desc order wrong: %v", pos)
	}

	// Comments: exact echo, then list.
	comment := "a comment with exact text"
	raw, _ = json.Marshal(map[string]string{"body": comment})
	w = doReq(t, h, "POST", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n1)+"/comments", string(raw))
	mustStatus(t, w, http.StatusCreated)
	var cm struct {
		ID   int    `json:"id"`
		Body string `json:"body"`
	}
	decodeJSON(t, w, &cm)
	if cm.Body != comment || cm.ID < 1 {
		t.Fatalf("comment = %+v", cm)
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n1)+"/comments", "")
	mustStatus(t, w, http.StatusOK)
	var cms []struct {
		ID   int    `json:"id"`
		Body string `json:"body"`
	}
	decodeJSON(t, w, &cms)
	found := false
	for _, c := range cms {
		if c.ID == cm.ID && c.Body == comment {
			found = true
		}
	}
	if !found {
		t.Fatalf("comment list misses the posted comment: %+v", cms)
	}

	// Cached single-GET still serves the closed state after the patch.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/iss/issues/"+strconv.Itoa(n2), "")
	mustStatus(t, w, http.StatusOK)
}

func setupPullRepo(t tb, h http.HandlerFunc, repo, head, variantPath, variantContent string) (int, string) {
	t.Helper()
	createRepo(t, h, repo)
	putFile(t, h, repo, "docs/readme.md", "seed\n", "", "")
	return addPull(t, h, repo, head, variantPath, variantContent)
}

// addPull opens a PR on an existing repo: branch from the main tip, one
// commit on the branch, then POST /pulls.
func addPull(t tb, h http.HandlerFunc, repo, head, variantPath, variantContent string) (int, string) {
	t.Helper()
	w := doReq(t, h, "GET", "/api/v3/repos/alice/"+repo+"/commits", "")
	mustStatus(t, w, http.StatusOK)
	var commits []struct {
		SHA string `json:"sha"`
	}
	decodeJSON(t, w, &commits)
	if len(commits) == 0 {
		t.Fatalf("no commits in repo %s", repo)
	}
	createBranch(t, h, repo, head, commits[0].SHA)
	putFile(t, h, repo, variantPath, variantContent, "", head)
	w = doReq(t, h, "POST", "/api/v3/repos/alice/"+repo+"/pulls",
		`{"head":"`+head+`","base":"main","title":"PR `+head+`","body":"pr body"}`)
	mustStatus(t, w, http.StatusCreated)
	var pr struct {
		Number int    `json:"number"`
		State  string `json:"state"`
		Head   struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"base"`
	}
	decodeJSON(t, w, &pr)
	if pr.State != "open" || pr.Head.Ref != head || pr.Base.Ref != "main" {
		t.Fatalf("PR shape wrong: %+v", pr)
	}
	return pr.Number, pr.Head.SHA
}

func TestPulls(t *testing.T) {
	h := Handler(newTestStore())
	n, headSHA := setupPullRepo(t, h, "pr", "feature-a", "docs/readme-a.md", "alt content\n")

	w := doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls/"+strconv.Itoa(n), "")
	mustStatus(t, w, http.StatusOK)
	var pr struct {
		Number int    `json:"number"`
		Title  string `json:"title"`
		Head   struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			Ref string `json:"ref"`
			SHA string `json:"sha"`
		} `json:"base"`
	}
	decodeJSON(t, w, &pr)
	if pr.Head.SHA != headSHA {
		t.Fatalf("head sha = %s, want %s", pr.Head.SHA, headSHA)
	}
	if pr.Title != "PR feature-a" {
		t.Fatalf("PR title = %q", pr.Title)
	}

	// Files.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls/"+strconv.Itoa(n)+"/files", "")
	mustStatus(t, w, http.StatusOK)
	var files []struct {
		Filename  string `json:"filename"`
		Status    string `json:"status"`
		Additions int    `json:"additions"`
		Deletions int    `json:"deletions"`
		Changes   int    `json:"changes"`
	}
	decodeJSON(t, w, &files)
	if len(files) == 0 {
		t.Fatalf("files list is empty")
	}
	found := false
	for _, f := range files {
		if f.Filename == "docs/readme-a.md" {
			found = true
			if f.Status != "added" && f.Status != "modified" && f.Status != "changed" {
				t.Fatalf("file status = %q", f.Status)
			}
			if f.Additions < 1 {
				t.Fatalf("additions = %d, want >= 1", f.Additions)
			}
		}
	}
	if !found {
		t.Fatalf("files list misses docs/readme-a.md: %+v", files)
	}

	// Unknown PR: 404.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls/999999999", "")
	mustStatus(t, w, http.StatusNotFound)
	w = doReq(t, h, "PUT", "/api/v3/repos/alice/pr/pulls/999999999/merge", `{"merge_method":"squash"}`)
	mustStatus(t, w, http.StatusNotFound)

	// Merge.
	w = doReq(t, h, "PUT", "/api/v3/repos/alice/pr/pulls/"+strconv.Itoa(n)+"/merge", `{"merge_method":"squash"}`)
	mustStatus(t, w, http.StatusOK)
	var merge struct {
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	decodeJSON(t, w, &merge)
	if !merge.Merged || len(merge.SHA) != 40 || merge.Message == "" {
		t.Fatalf("merge reply wrong: %+v", merge)
	}

	// PR closed + merged, merge_commit_sha matches.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls/"+strconv.Itoa(n), "")
	var pr2 struct {
		State          string `json:"state"`
		Merged         bool   `json:"merged"`
		MergedAt       string `json:"merged_at"`
		MergeCommitSHA string `json:"merge_commit_sha"`
	}
	decodeJSON(t, w, &pr2)
	if pr2.State != "closed" || !pr2.Merged || pr2.MergedAt == "" {
		t.Fatalf("merged PR wrong: %+v", pr2)
	}
	if pr2.MergeCommitSHA != merge.SHA {
		t.Fatalf("merge_commit_sha = %s, want %s", pr2.MergeCommitSHA, merge.SHA)
	}

	// Merge commit is on the default branch.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/commits?sha=main", "")
	var commits []struct {
		SHA string `json:"sha"`
	}
	decodeJSON(t, w, &commits)
	foundSHA := false
	for _, c := range commits {
		if c.SHA == merge.SHA {
			foundSHA = true
		}
	}
	if !foundSHA {
		t.Fatalf("merge commit not in GET /commits?sha=main")
	}

	// Squashed content is on the default branch.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/contents/docs/readme-a.md?ref=main", "")
	mustStatus(t, w, http.StatusOK)
	var file struct {
		Content string `json:"content"`
	}
	decodeJSON(t, w, &file)
	raw, _ := base64.StdEncoding.DecodeString(file.Content)
	if string(raw) != "alt content\n" {
		t.Fatalf("merged content = %q", raw)
	}

	// Lists: state=all shows the merged PR, default (open) hides it.
	_, _ = addPull(t, h, "pr", "feature-b", "docs/readme-b.md", "b content\n")
	// The second PR is number 2 in the same repo.
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls?state=all&per_page=100", "")
	var all []struct {
		Number int `json:"number"`
	}
	decodeJSON(t, w, &all)
	if len(all) != 2 {
		t.Fatalf("state=all list = %d PRs, want 2", len(all))
	}
	w = doReq(t, h, "GET", "/api/v3/repos/alice/pr/pulls?per_page=100", "")
	var open []struct {
		Number int `json:"number"`
	}
	decodeJSON(t, w, &open)
	if len(open) != 1 || open[0].Number != 2 {
		t.Fatalf("default list = %+v, want only PR 2", open)
	}
}

func TestMergeConflict(t *testing.T) {
	h := Handler(newTestStore())
	createRepo(t, h, "cf")
	_, first := putFile(t, h, "cf", "shared.txt", "base\n", "", "")
	createBranch(t, h, "cf", "branch-a", first)
	createBranch(t, h, "cf", "branch-b", first)
	shaA := getFileSHA(t, h, "cf", "shared.txt")
	putFile(t, h, "cf", "shared.txt", "content A\n", shaA, "branch-a")
	putFile(t, h, "cf", "shared.txt", "content B\n", shaA, "branch-b")

	mkPR := func(head string) int {
		w := doReq(t, h, "POST", "/api/v3/repos/alice/cf/pulls",
			`{"head":"`+head+`","base":"main","title":"PR `+head+`","body":"b"}`)
		mustStatus(t, w, http.StatusCreated)
		var pr struct {
			Number int `json:"number"`
		}
		decodeJSON(t, w, &pr)
		return pr.Number
	}
	na := mkPR("branch-a")
	nb := mkPR("branch-b")

	w := doReq(t, h, "PUT", "/api/v3/repos/alice/cf/pulls/"+strconv.Itoa(na)+"/merge", `{"merge_method":"squash"}`)
	mustStatus(t, w, http.StatusOK)
	w = doReq(t, h, "PUT", "/api/v3/repos/alice/cf/pulls/"+strconv.Itoa(nb)+"/merge", `{"merge_method":"squash"}`)
	mustStatus(t, w, http.StatusMethodNotAllowed)
}

func TestProtocolErrors(t *testing.T) {
	h := Handler(newTestStore())
	createRepo(t, h, "err")

	// Malformed JSON body: 400.
	w := doReq(t, h, "POST", "/api/v3/user/repos", `{"name":`)
	mustStatus(t, w, http.StatusBadRequest)
	var errBody map[string]string
	decodeJSON(t, w, &errBody)
	if errBody["message"] == "" {
		t.Fatalf("400 must carry a message")
	}

	// Unknown route: 404 JSON.
	w = doReq(t, h, "GET", "/api/v3/no-such-route/whatever", "")
	mustStatus(t, w, http.StatusNotFound)
	decodeJSON(t, w, &errBody)
	if errBody["message"] == "" {
		t.Fatalf("404 must carry a message")
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("error content type = %q, want application/json", ct)
	}
}
