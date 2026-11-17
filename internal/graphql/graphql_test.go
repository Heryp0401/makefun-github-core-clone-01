package graphql

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"forge/internal/store"
)

func testStore() *store.Store {
	s := store.NewStore("test-token")
	s.LearnViewer("octocat")
	return s
}

func testRepo(s *store.Store, name string) *store.Repo {
	r := s.CreateRepo("octocat", name, false, "test repo")
	return r
}

func addIssue(r *store.Repo, title, state string) *store.Issue {
	iss := &store.Issue{
		Number:    r.NextIssue,
		Title:     title,
		Body:      "body of " + title,
		State:     state,
		CreatedAt: "2026-01-01T00:00:00Z",
		UpdatedAt: "2026-01-01T00:00:00Z",
	}
	r.NextIssue++
	r.Issues = append(r.Issues, iss)
	return iss
}

func doGQL(t *testing.T, s *store.Store, query string, vars map[string]any) map[string]any {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"query": query, "variables": vars})
	req := httptest.NewRequest(http.MethodPost, "/api/graphql", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	Handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad JSON: %v; body %s", err, rec.Body.String())
	}
	return out
}

func noErrors(t *testing.T, out map[string]any) {
	t.Helper()
	if errs, ok := out["errors"]; ok {
		t.Fatalf("unexpected errors: %v", errs)
	}
}

func dataMap(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	noErrors(t, out)
	d, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatalf("data is not an object: %v", out)
	}
	return d
}

func TestViewerLogin(t *testing.T) {
	s := testStore()
	d := dataMap(t, doGQL(t, s, `query ViewerLogin { viewer { login } }`, nil))
	viewer := d["viewer"].(map[string]any)
	if viewer["login"] != "octocat" {
		t.Fatalf("login = %v, want octocat", viewer["login"])
	}
}

func TestRepositoryFields(t *testing.T) {
	s := testStore()
	r := testRepo(s, "hello-graphql")
	q := `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) {
	    id databaseId name owner { login } defaultBranchRef { name }
	    viewerPermission hasIssuesEnabled
	  }
	}`
	d := dataMap(t, doGQL(t, s, q, map[string]any{"owner": "octocat", "name": "hello-graphql"}))
	repo := d["repository"].(map[string]any)
	if repo["name"] != "hello-graphql" {
		t.Fatalf("name = %v", repo["name"])
	}
	if repo["databaseId"] != float64(r.DatabaseID) {
		t.Fatalf("databaseId = %v, want %d", repo["databaseId"], r.DatabaseID)
	}
	if id, _ := repo["id"].(string); id == "" || id == strconv.Itoa(r.DatabaseID) {
		t.Fatalf("id = %q, want opaque non-empty id", id)
	}
	if owner, _ := repo["owner"].(map[string]any); owner["login"] != "octocat" {
		t.Fatalf("owner.login = %v", owner)
	}
	if ref, _ := repo["defaultBranchRef"].(map[string]any); ref["name"] != "main" {
		t.Fatalf("defaultBranchRef.name = %v", ref)
	}
	if repo["viewerPermission"] != "ADMIN" {
		t.Fatalf("viewerPermission = %v", repo["viewerPermission"])
	}
	if repo["hasIssuesEnabled"] != true {
		t.Fatalf("hasIssuesEnabled = %v", repo["hasIssuesEnabled"])
	}
}

func TestIntrospection(t *testing.T) {
	s := testStore()
	d := dataMap(t, doGQL(t, s, `query Issue_fields {
	  Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } }
	}`, nil))
	fields := d["Issue"].(map[string]any)["fields"].([]any)
	names := map[string]bool{}
	for _, f := range fields {
		names[f.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"id", "number", "title", "state", "body"} {
		if !names[want] {
			t.Fatalf("Issue fields missing %q: %v", want, names)
		}
	}

	d = dataMap(t, doGQL(t, s, `query PullRequestAndRepositoryFields {
	  PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
	  Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } }
	}`, nil))
	fields = d["PullRequest"].(map[string]any)["fields"].([]any)
	names = map[string]bool{}
	for _, f := range fields {
		names[f.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"id", "number", "headRefName", "baseRefName", "mergeable", "state", "merged", "files"} {
		if !names[want] {
			t.Fatalf("PullRequest fields missing %q", want)
		}
	}
	fields = d["Repository"].(map[string]any)["fields"].([]any)
	names = map[string]bool{}
	for _, f := range fields {
		names[f.(map[string]any)["name"].(string)] = true
	}
	for _, want := range []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest"} {
		if !names[want] {
			t.Fatalf("Repository fields missing %q", want)
		}
	}

	d = dataMap(t, doGQL(t, s, `query SearchType_enumValues {
	  SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } }
	}`, nil))
	vals := d["SearchType"].(map[string]any)["enumValues"].([]any)
	found := false
	for _, v := range vals {
		if v.(map[string]any)["name"] == "ISSUE" {
			found = true
		}
	}
	if !found {
		t.Fatalf("SearchType enumValues missing ISSUE: %v", vals)
	}
}

func TestOpenIssuesOrderDesc(t *testing.T) {
	s := testStore()
	r := testRepo(s, "issues-repo")
	addIssue(r, "prefix open 1", "open")
	addIssue(r, "prefix open 2", "open")
	addIssue(r, "prefix open 3", "open")
	addIssue(r, "prefix closed", "closed")
	q := `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
	  repository(owner: $owner, name: $name) {
	    issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) {
	      nodes { number title state id }
	    }
	  }
	}`
	d := dataMap(t, doGQL(t, s, q, map[string]any{"owner": "octocat", "name": "issues-repo", "first": 10}))
	nodes := d["repository"].(map[string]any)["issues"].(map[string]any)["nodes"].([]any)
	if len(nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(nodes))
	}
	prev := 1 << 30
	for _, n := range nodes {
		node := n.(map[string]any)
		if node["state"] != "OPEN" {
			t.Fatalf("state = %v", node["state"])
		}
		num := int(node["number"].(float64))
		if num >= prev {
			t.Fatalf("numbers not strictly descending: %v", nodes)
		}
		prev = num
		if node["id"] == "" {
			t.Fatalf("empty id")
		}
	}
}

func TestIssueByNumber(t *testing.T) {
	s := testStore()
	r := testRepo(s, "one-issue")
	addIssue(r, "prefix open 1", "open")
	q := `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
	  repository(owner: $owner, name: $name) {
	    issue(number: $number) { number title state id body }
	  }
	}`
	d := dataMap(t, doGQL(t, s, q, map[string]any{"owner": "octocat", "name": "one-issue", "number": 1}))
	iss := d["repository"].(map[string]any)["issue"].(map[string]any)
	if iss["number"] != float64(1) || iss["title"] != "prefix open 1" || iss["state"] != "OPEN" {
		t.Fatalf("issue = %v", iss)
	}
	if iss["body"] != "body of prefix open 1" {
		t.Fatalf("body = %v", iss["body"])
	}
}

func TestCreateAndCloseIssue(t *testing.T) {
	s := testStore()
	r := testRepo(s, "mut-repo")
	// Read the repository global id first.
	d := dataMap(t, doGQL(t, s, `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) { id }
	}`, map[string]any{"owner": "octocat", "name": "mut-repo"}))
	repoID := d["repository"].(map[string]any)["id"].(string)

	d = dataMap(t, doGQL(t, s, `mutation IssueCreate($input: CreateIssueInput!) {
	  createIssue(input: $input) { issue { number id } }
	}`, map[string]any{"input": map[string]any{"repositoryId": repoID, "title": "created over graphql", "body": "seeded body"}}))
	created := d["createIssue"].(map[string]any)["issue"].(map[string]any)
	if created["number"] != float64(1) {
		t.Fatalf("number = %v", created["number"])
	}
	if len(r.Issues) != 1 || r.Issues[0].Title != "created over graphql" {
		t.Fatalf("store issue missing: %+v", r.Issues)
	}
	issueID := created["id"].(string)

	d = dataMap(t, doGQL(t, s, `mutation IssueClose($input: CloseIssueInput!) {
	  closeIssue(input: $input) { issue { number id state } }
	}`, map[string]any{"input": map[string]any{"issueId": issueID}}))
	closed := d["closeIssue"].(map[string]any)["issue"].(map[string]any)
	if closed["state"] != "CLOSED" || closed["number"] != float64(1) {
		t.Fatalf("closed = %v", closed)
	}
	if r.Issues[0].State != "closed" {
		t.Fatalf("store state = %q", r.Issues[0].State)
	}
}

func TestAddComment(t *testing.T) {
	s := testStore()
	r := testRepo(s, "comment-repo")
	iss := addIssue(r, "with comment", "open")
	issueID := issueIDFor(r, iss.Number)
	d := dataMap(t, doGQL(t, s, `mutation AddComment($input: AddCommentInput!) {
	  addComment(input: $input) { commentEdge { node { id body } } }
	}`, map[string]any{"input": map[string]any{"subjectId": issueID, "body": "seeded comment"}}))
	node := d["addComment"].(map[string]any)["commentEdge"].(map[string]any)["node"].(map[string]any)
	if node["body"] != "seeded comment" {
		t.Fatalf("body = %v", node["body"])
	}
	if node["id"] == "" {
		t.Fatalf("empty comment id")
	}
	if len(iss.Comments) != 1 || iss.Comments[0].Body != "seeded comment" {
		t.Fatalf("store comments = %+v", iss.Comments)
	}
}

func issueIDFor(r *store.Repo, n int) string {
	return issueID(r, n)
}

func TestIssuesPagination5Plus2(t *testing.T) {
	s := testStore()
	r := testRepo(s, "pages-repo")
	for i := 1; i <= 7; i++ {
		addIssue(r, "issue "+string(rune('0'+i)), "open")
	}
	q := `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
	  repository(owner: $owner, name: $name) {
	    issues(first: $first, after: $after) {
	      nodes { number }
	      pageInfo { hasNextPage endCursor }
	    }
	  }
	}`
	vars := map[string]any{"owner": "octocat", "name": "pages-repo", "first": 5, "after": nil}
	d := dataMap(t, doGQL(t, s, q, vars))
	page := d["repository"].(map[string]any)["issues"].(map[string]any)
	nodes := page["nodes"].([]any)
	if len(nodes) != 5 {
		t.Fatalf("first page nodes = %d, want 5", len(nodes))
	}
	pi := page["pageInfo"].(map[string]any)
	if pi["hasNextPage"] != true {
		t.Fatalf("hasNextPage = %v", pi["hasNextPage"])
	}
	cursor, _ := pi["endCursor"].(string)
	if cursor == "" {
		t.Fatalf("empty endCursor")
	}
	seen := map[int]bool{}
	for _, n := range nodes {
		seen[int(n.(map[string]any)["number"].(float64))] = true
	}
	vars["after"] = cursor
	d = dataMap(t, doGQL(t, s, q, vars))
	page = d["repository"].(map[string]any)["issues"].(map[string]any)
	nodes = page["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("second page nodes = %d, want 2", len(nodes))
	}
	pi = page["pageInfo"].(map[string]any)
	if pi["hasNextPage"] != false {
		t.Fatalf("hasNextPage = %v", pi["hasNextPage"])
	}
	for _, n := range nodes {
		num := int(n.(map[string]any)["number"].(float64))
		if seen[num] {
			t.Fatalf("number %d on both pages", num)
		}
		seen[num] = true
	}
	if len(seen) != 7 {
		t.Fatalf("seen %d numbers, want 7", len(seen))
	}
}

func TestInvalidField(t *testing.T) {
	s := testStore()
	out := doGQL(t, s, `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`, nil)
	errs, ok := out["errors"].([]any)
	if !ok || len(errs) == 0 {
		t.Fatalf("expected errors, got %v", out)
	}
	found := false
	for _, e := range errs {
		if msg, _ := e.(map[string]any)["message"].(string); strings.Contains(msg, "noSuchFieldOnViewer") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no error mentions noSuchFieldOnViewer: %v", errs)
	}
}

func TestUnknownRepository(t *testing.T) {
	s := testStore()
	out := doGQL(t, s, `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) { id name }
	}`, map[string]any{"owner": "octocat", "name": "never-created"})
	d, ok := out["data"].(map[string]any)
	if !ok {
		t.Fatalf("no data: %v", out)
	}
	if d["repository"] != nil {
		t.Fatalf("repository = %v, want null", d["repository"])
	}
	if _, hasErrs := out["errors"]; hasErrs {
		t.Fatalf("unexpected errors: %v", out["errors"])
	}
}

func TestBatchedOperations(t *testing.T) {
	s := testStore()
	ops := []map[string]any{
		{"query": `query ViewerLogin { viewer { login } }`, "variables": map[string]any{}},
		{"query": `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`, "variables": map[string]any{}},
	}
	body, _ := json.Marshal(ops)
	req := httptest.NewRequest(http.MethodPost, "/api/graphql", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	Handler(s).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("batched body not an array: %v; %s", err, rec.Body.String())
	}
	if len(out) != 2 {
		t.Fatalf("len = %d, want 2", len(out))
	}
	first := out[0]["data"].(map[string]any)["viewer"].(map[string]any)
	if first["login"] != "octocat" {
		t.Fatalf("first login = %v", first["login"])
	}
	fields := out[1]["data"].(map[string]any)["Issue"].(map[string]any)["fields"].([]any)
	if len(fields) == 0 {
		t.Fatalf("second op has no fields")
	}
}

func TestGlobalIDStability(t *testing.T) {
	s := testStore()
	r := testRepo(s, "stable-repo")
	addIssue(r, "prefix open 1", "open")
	q := `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) { id databaseId }
	}`
	vars := map[string]any{"owner": "octocat", "name": "stable-repo"}
	d1 := dataMap(t, doGQL(t, s, q, vars))
	d2 := dataMap(t, doGQL(t, s, q, vars))
	id1 := d1["repository"].(map[string]any)["id"].(string)
	id2 := d2["repository"].(map[string]any)["id"].(string)
	if id1 != id2 {
		t.Fatalf("repo ids differ: %q vs %q", id1, id2)
	}
	dbID := d1["repository"].(map[string]any)["databaseId"]
	if id1 == strconv.Itoa(int(dbID.(float64))) {
		t.Fatalf("repo id is the plain databaseId: %q", id1)
	}
	_ = r
}

func TestNodeRepository(t *testing.T) {
	s := testStore()
	r := testRepo(s, "node-repo")
	d := dataMap(t, doGQL(t, s, `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) { id }
	}`, map[string]any{"owner": "octocat", "name": "node-repo"}))
	id := d["repository"].(map[string]any)["id"].(string)
	d = dataMap(t, doGQL(t, s, `query NodeRepository($id: ID!) {
	  node(id: $id) { id ... on Repository { name nameWithOwner } }
	}`, map[string]any{"id": id}))
	node := d["node"].(map[string]any)
	if node["id"] != id {
		t.Fatalf("node id = %v", node["id"])
	}
	if node["name"] != "node-repo" {
		t.Fatalf("node name = %v", node["name"])
	}
	if node["nameWithOwner"] != "octocat/node-repo" {
		t.Fatalf("nameWithOwner = %v", node["nameWithOwner"])
	}
	_ = r
}

// TestCreateAndMergePullRequest exercises the git-backed PR flow with
// minimal hand-built commit objects (empty trees, distinct shas).
func TestCreateAndMergePullRequest(t *testing.T) {
	s := testStore()
	r := testRepo(s, "pr-repo")
	baseTree := r.PutObject("tree", []byte(""))
	headTree := r.PutObject("tree", []byte("x"))
	baseCommit := r.PutObject("commit", []byte("tree "+baseTree+"\n"))
	headCommit := r.PutObject("commit", []byte("tree "+headTree+"\nparent "+baseCommit+"\n"))
	r.SetRef("refs/heads/main", baseCommit)
	r.SetRef("refs/heads/feature", headCommit)

	d := dataMap(t, doGQL(t, s, `query RepositoryFields($owner: String!, $name: String!) {
	  repository(owner: $owner, name: $name) { id }
	}`, map[string]any{"owner": "octocat", "name": "pr-repo"}))
	repoID := d["repository"].(map[string]any)["id"].(string)

	d = dataMap(t, doGQL(t, s, `mutation PullRequestCreate($input: CreatePullRequestInput!) {
	  createPullRequest(input: $input) {
	    pullRequest { number id state headRefName baseRefName }
	  }
	}`, map[string]any{"input": map[string]any{
		"repositoryId": repoID, "baseRefName": "main", "headRefName": "feature",
		"title": "created over graphql",
	}}))
	pr := d["createPullRequest"].(map[string]any)["pullRequest"].(map[string]any)
	if pr["number"] != float64(1) || pr["state"] != "OPEN" {
		t.Fatalf("pr = %v", pr)
	}
	if pr["headRefName"] != "feature" || pr["baseRefName"] != "main" {
		t.Fatalf("pr refs = %v", pr)
	}
	if len(r.Pulls) != 1 {
		t.Fatalf("store pulls = %d", len(r.Pulls))
	}
	prID := pr["id"].(string)

	d = dataMap(t, doGQL(t, s, `mutation MergePullRequest($input: MergePullRequestInput!) {
	  mergePullRequest(input: $input) { pullRequest { number merged state } }
	}`, map[string]any{"input": map[string]any{"pullRequestId": prID, "mergeMethod": "SQUASH"}}))
	merged := d["mergePullRequest"].(map[string]any)["pullRequest"].(map[string]any)
	if merged["merged"] != true || merged["state"] != "CLOSED" {
		t.Fatalf("merged = %v", merged)
	}
	if !r.Pulls[0].Merged || r.Pulls[0].MergeCommitSHA == "" {
		t.Fatalf("store pr not merged: %+v", r.Pulls[0])
	}
	if r.Ref("refs/heads/main") != r.Pulls[0].MergeCommitSHA {
		t.Fatalf("main ref not moved to merge commit")
	}
}
