package mcp

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"forge/internal/store"
)

func testStore() *store.Store {
	s := store.NewStore("test-token")
	s.LearnViewer("octocat")
	return s
}

func doRPC(t *testing.T, s *store.Store, body any) (int, map[string]any) {
	t.Helper()
	var raw []byte
	switch b := body.(type) {
	case string:
		raw = []byte(b)
	default:
		raw, _ = json.Marshal(b)
	}
	req := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	Handler(s).ServeHTTP(rec, req)
	var out map[string]any
	if len(rec.Body.Bytes()) > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("bad JSON: %v; body %s", err, rec.Body.String())
		}
	}
	return rec.Code, out
}

func call(t *testing.T, s *store.Store, id any, method string, params map[string]any) (int, map[string]any) {
	t.Helper()
	return doRPC(t, s, map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

func resultMap(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	if errObj, ok := out["error"]; ok {
		t.Fatalf("unexpected JSON-RPC error: %v", errObj)
	}
	res, ok := out["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result: %v", out)
	}
	return res
}

func toolCall(t *testing.T, s *store.Store, id any, name string, args map[string]any) (int, map[string]any) {
	t.Helper()
	return call(t, s, id, "tools/call", map[string]any{"name": name, "arguments": args})
}

func toolText(t *testing.T, res map[string]any) (string, map[string]any) {
	t.Helper()
	content, ok := res["content"].([]any)
	if !ok || len(content) == 0 {
		t.Fatalf("no content: %v", res)
	}
	text, _ := content[0].(map[string]any)["text"].(string)
	var obj map[string]any
	if err := json.Unmarshal([]byte(text), &obj); err == nil {
		return text, obj
	}
	return text, nil
}

func TestDiscover(t *testing.T) {
	s := testStore()
	_, out := call(t, s, 1, "server/discover", map[string]any{})
	res := resultMap(t, out)
	sv, ok := res["supportedVersions"].([]any)
	if !ok || len(sv) == 0 {
		t.Fatalf("supportedVersions = %v", res["supportedVersions"])
	}
	for _, v := range sv {
		vs, _ := v.(string)
		if len(vs) != 10 || vs[4] != '-' || vs[7] != '-' {
			t.Fatalf("supportedVersions entry not YYYY-MM-DD: %q", vs)
		}
	}
	info := res["serverInfo"].(map[string]any)
	if info["name"] == "" || info["version"] == "" {
		t.Fatalf("serverInfo = %v", info)
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatalf("capabilities.tools missing: %v", res["capabilities"])
	}
}

func TestInitialize(t *testing.T) {
	s := testStore()
	_, out := call(t, s, 2, "initialize", map[string]any{
		"protocolVersion": "2025-11-25",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "test", "version": "1.0.0"},
	})
	res := resultMap(t, out)
	if res["protocolVersion"] != "2025-11-25" {
		t.Fatalf("protocolVersion = %v", res["protocolVersion"])
	}
	info := res["serverInfo"].(map[string]any)
	if info["name"] == "" || info["version"] == "" {
		t.Fatalf("serverInfo = %v", info)
	}
	if _, ok := res["capabilities"].(map[string]any)["tools"]; !ok {
		t.Fatalf("capabilities.tools missing")
	}
}

func toolsList(t *testing.T, s *store.Store, id any) []any {
	t.Helper()
	_, out := call(t, s, id, "tools/list", map[string]any{})
	res := resultMap(t, out)
	list, ok := res["tools"].([]any)
	if !ok {
		t.Fatalf("tools not an array: %v", res)
	}
	return list
}

func TestToolsList(t *testing.T) {
	s := testStore()
	list := toolsList(t, s, 3)
	if len(list) < 6 {
		t.Fatalf("tools = %d, want >= 6", len(list))
	}
	names := map[string]bool{}
	for _, tool := range list {
		m := tool.(map[string]any)
		names[m["name"].(string)] = true
		if m["description"] == "" {
			t.Fatalf("tool %v has empty description", m["name"])
		}
		schema, ok := m["inputSchema"].(map[string]any)
		if !ok || schema["type"] != "object" {
			t.Fatalf("tool %v inputSchema not object: %v", m["name"], m["inputSchema"])
		}
	}
	for _, want := range []string{"create_repo", "get_repo", "create_issue", "list_issues", "create_pull_request", "merge_pull_request"} {
		if !names[want] {
			t.Fatalf("missing tool %q", want)
		}
	}
}

func TestToolsListIdempotent(t *testing.T) {
	s := testStore()
	_, out1 := call(t, s, 1, "tools/list", map[string]any{})
	_, out2 := call(t, s, 2, "tools/list", map[string]any{})
	b1, _ := json.Marshal(resultMap(t, out1)["tools"])
	b2, _ := json.Marshal(resultMap(t, out2)["tools"])
	if !bytes.Equal(b1, b2) {
		t.Fatalf("tools/list differs between calls:\n%s\n%s", b1, b2)
	}
}

func TestUnknownTool(t *testing.T) {
	s := testStore()
	_, out := toolCall(t, s, 9, "mcp_no_such_tool_abc", map[string]any{})
	errObj, ok := out["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected JSON-RPC error, got %v", out)
	}
	code := int(errObj["code"].(float64))
	if code != -32602 && code != -32601 {
		t.Fatalf("code = %d, want -32602 or -32601", code)
	}
}

func TestParseError(t *testing.T) {
	s := testStore()
	status, out := doRPC(t, s, `{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"`)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	errObj, ok := out["error"].(map[string]any)
	if !ok {
		t.Fatalf("expected error object: %v", out)
	}
	if int(errObj["code"].(float64)) != -32700 {
		t.Fatalf("code = %v, want -32700", errObj["code"])
	}
}

func TestMissingArguments(t *testing.T) {
	s := testStore()
	_, out := toolCall(t, s, 5, "create_issue", map[string]any{})
	if errObj, ok := out["error"].(map[string]any); ok {
		if int(errObj["code"].(float64)) != -32602 {
			t.Fatalf("code = %v, want -32602", errObj["code"])
		}
		return
	}
	res := resultMap(t, out)
	if res["isError"] != true {
		t.Fatalf("expected isError true, got %v", res)
	}
}

func TestCreateRepoAndIssueParity(t *testing.T) {
	s := testStore()
	_, out := toolCall(t, s, 1, "create_repo", map[string]any{
		"owner": "octocat", "name": "mcp-parity", "description": "seeded", "private": true,
	})
	res := resultMap(t, out)
	if res["isError"] == true {
		t.Fatalf("create_repo failed: %v", res)
	}
	r := s.GetRepo("octocat", "mcp-parity")
	if r == nil {
		t.Fatalf("repo not in store after MCP create")
	}
	_, out = toolCall(t, s, 2, "create_issue", map[string]any{
		"owner": "octocat", "repo": "mcp-parity", "title": "mcp issue", "body": "seeded body",
	})
	res = resultMap(t, out)
	_, obj := toolText(t, res)
	if obj == nil || obj["number"] != float64(1) {
		t.Fatalf("create_issue result = %v", res)
	}
	if len(r.Issues) != 1 || r.Issues[0].Title != "mcp issue" {
		t.Fatalf("store issues = %+v", r.Issues)
	}

	_, out = toolCall(t, s, 3, "list_issues", map[string]any{
		"owner": "octocat", "repo": "mcp-parity", "state": "open",
	})
	res = resultMap(t, out)
	text, _ := toolText(t, res)
	if !strings.Contains(text, "mcp issue") {
		t.Fatalf("list_issues text missing title: %s", text)
	}
}

func TestConcurrentCalls(t *testing.T) {
	s := testStore()
	s.CreateRepo("octocat", "left-repo", false, "")
	s.CreateRepo("octocat", "right-repo", false, "")
	var wg sync.WaitGroup
	results := make([]map[string]any, 2)
	ids := []string{"concurrent-left-x", "concurrent-right-x"}
	repos := []string{"left-repo", "right-repo"}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, out := toolCall(t, s, ids[i], "get_repo", map[string]any{"owner": "octocat", "repo": repos[i]})
			results[i] = out
		}(i)
	}
	wg.Wait()
	for i := 0; i < 2; i++ {
		out := results[i]
		if out["id"] != ids[i] {
			t.Fatalf("id mismatch: got %v want %v (out %v)", out["id"], ids[i], out)
		}
		res := resultMap(t, out)
		text, _ := toolText(t, res)
		if !strings.Contains(text, repos[i]) {
			t.Fatalf("result text missing repo %q: %s", repos[i], text)
		}
	}
}

func TestCreateAndMergePullRequest(t *testing.T) {
	s := testStore()
	r := s.CreateRepo("octocat", "mcp-pr", false, "")
	baseTree := r.PutObject("tree", []byte(""))
	headTree := r.PutObject("tree", []byte("x"))
	baseCommit := r.PutObject("commit", []byte("tree "+baseTree+"\n"))
	headCommit := r.PutObject("commit", []byte("tree "+headTree+"\nparent "+baseCommit+"\n"))
	r.SetRef("refs/heads/main", baseCommit)
	r.SetRef("refs/heads/mcp-head", headCommit)

	_, out := toolCall(t, s, 1, "create_pull_request", map[string]any{
		"owner": "octocat", "repo": "mcp-pr", "title": "mcp pr",
		"head": "mcp-head", "base": "main",
	})
	res := resultMap(t, out)
	_, obj := toolText(t, res)
	if obj == nil || obj["number"] != float64(1) {
		t.Fatalf("create_pull_request result = %v", res)
	}
	if len(r.Pulls) != 1 {
		t.Fatalf("store pulls = %d", len(r.Pulls))
	}

	_, out = toolCall(t, s, 2, "merge_pull_request", map[string]any{
		"owner": "octocat", "repo": "mcp-pr", "pull_number": 1,
	})
	res = resultMap(t, out)
	_, obj = toolText(t, res)
	if obj == nil || obj["merged"] != true {
		t.Fatalf("merge result = %v", res)
	}
	if !r.Pulls[0].Merged || r.Pulls[0].MergeCommitSHA == "" {
		t.Fatalf("store pr not merged: %+v", r.Pulls[0])
	}
}
