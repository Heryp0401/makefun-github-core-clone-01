// Package mcp implements the Model Context Protocol endpoint (POST /mcp)
// as JSON-RPC 2.0 over Streamable HTTP. It speaks the modern 2026-07-28
// revision (server/discover) and the legacy handshake (initialize +
// notifications/initialized), offers the six required tools, and acts on
// the same store as REST and GraphQL. Plain JSON answers are used; no SSE
// stream is needed.
package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"forge/internal/git"
	"forge/internal/store"
	"forge/internal/util"
)

// Handler returns the MCP endpoint. Auth is enforced by the server wrapper,
// so this handler assumes an authenticated request.
func Handler(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusOK)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			util.WriteErr(w, http.StatusBadRequest, "cannot read body")
			return
		}
		status, out := handleRequest(s, body)
		util.WriteJSONBytes(w, status, out)
	}
}

// rpcError is one JSON-RPC error object.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// rpcRequest is one decoded JSON-RPC request. ID is kept raw so string and
// numeric ids round-trip verbatim.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// rpcResponse is one JSON-RPC response envelope.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func respond(id json.RawMessage, result any) (int, []byte) {
	if id == nil {
		return http.StatusAccepted, nil
	}
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: id, Result: result})
	return http.StatusOK, b
}

func respondErr(id json.RawMessage, code int, msg string) (int, []byte) {
	if id == nil {
		return http.StatusAccepted, nil
	}
	b, _ := json.Marshal(rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}})
	return http.StatusOK, b
}

var idPattern = regexp.MustCompile(`"id"\s*:\s*(-?[0-9]+|"(?:[^"\\]|\\.)*")`)

// extractID leniently pulls an "id" value out of raw (possibly truncated)
// JSON, so a parse-error reply can still echo the caller's id.
func extractID(body []byte) json.RawMessage {
	m := idPattern.FindSubmatch(body)
	if m == nil {
		return json.RawMessage("null")
	}
	return json.RawMessage(m[1])
}

// handleRequest dispatches one MCP request body and returns the HTTP status
// and response bytes. Responses are built fully before returning; the
// caller writes them to the network.
func handleRequest(s *store.Store, body []byte) (int, []byte) {
	trimmed := bytes.TrimSpace(body)
	var req rpcRequest
	if err := json.Unmarshal(trimmed, &req); err != nil {
		b, _ := json.Marshal(rpcResponse{
			JSONRPC: "2.0",
			ID:      extractID(trimmed),
			Error:   &rpcError{Code: -32700, Message: "Parse error"},
		})
		return http.StatusBadRequest, b
	}
	if req.Method == "" {
		return respondErr(req.ID, -32600, "Invalid Request: missing method")
	}
	// Notifications carry no id and get no response body.
	if req.ID == nil {
		switch req.Method {
		case "notifications/initialized", "notifications/cancelled", "notifications/progress":
			return http.StatusAccepted, nil
		}
		return http.StatusAccepted, nil
	}
	switch req.Method {
	case "server/discover":
		return respond(req.ID, map[string]any{
			"serverInfo": map[string]any{"name": "forge-mcp", "version": "1.0.0"},
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
			"supportedVersions": []string{"2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"},
		})
	case "initialize":
		version := "2025-11-25"
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 {
			_ = json.Unmarshal(req.Params, &params)
			if params.ProtocolVersion != "" {
				version = params.ProtocolVersion
			}
		}
		return respond(req.ID, map[string]any{
			"protocolVersion": version,
			"serverInfo":      map[string]any{"name": "forge-mcp", "version": "1.0.0"},
			"capabilities": map[string]any{
				"tools": map[string]any{},
			},
		})
	case "ping":
		return respond(req.ID, map[string]any{})
	case "tools/list":
		return respond(req.ID, map[string]any{"tools": json.RawMessage(toolsArrayJSON)})
	case "tools/call":
		return callTool(s, req)
	}
	return respondErr(req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
}

// --- tools ---------------------------------------------------------------

// toolDef is one tool offered by tools/list.
type toolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

func schema(props map[string]any, required []string) map[string]any {
	return map[string]any{
		"type":       "object",
		"properties": props,
		"required":   required,
	}
}

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}
func boolProp(desc string) map[string]any {
	return map[string]any{"type": "boolean", "description": desc}
}
func intProp(desc string) map[string]any {
	return map[string]any{"type": "integer", "description": desc}
}

// tools is the full tool catalogue. toolsArrayJSON is serialised exactly
// once, so every tools/list answer carries byte-identical tool data.
var tools = []toolDef{
	{
		Name:        "create_repo",
		Description: "Create a new repository owned by the viewer.",
		InputSchema: schema(map[string]any{
			"owner":       strProp("Owner login of the new repository"),
			"name":        strProp("Name of the repository to create"),
			"description": strProp("Description of the repository"),
			"private":     boolProp("Whether the repository is private"),
		}, []string{"name"}),
	},
	{
		Name:        "get_repo",
		Description: "Get a repository by owner and name.",
		InputSchema: schema(map[string]any{
			"owner": strProp("Owner login of the repository"),
			"repo":  strProp("Name of the repository"),
		}, []string{"owner", "repo"}),
	},
	{
		Name:        "create_issue",
		Description: "Create an issue in a repository.",
		InputSchema: schema(map[string]any{
			"owner": strProp("Owner login of the repository"),
			"repo":  strProp("Name of the repository"),
			"title": strProp("Title of the issue"),
			"body":  strProp("Body of the issue"),
		}, []string{"owner", "repo", "title"}),
	},
	{
		Name:        "list_issues",
		Description: "List issues of a repository, optionally filtered by state.",
		InputSchema: schema(map[string]any{
			"owner": strProp("Owner login of the repository"),
			"repo":  strProp("Name of the repository"),
			"state": strProp("Issue state filter: open, closed, or all"),
		}, []string{"owner", "repo"}),
	},
	{
		Name:        "create_pull_request",
		Description: "Create a pull request from a head branch onto a base branch.",
		InputSchema: schema(map[string]any{
			"owner": strProp("Owner login of the repository"),
			"repo":  strProp("Name of the repository"),
			"title": strProp("Title of the pull request"),
			"body":  strProp("Body of the pull request"),
			"head":  strProp("Head branch name"),
			"base":  strProp("Base branch name"),
		}, []string{"owner", "repo", "title", "head", "base"}),
	},
	{
		Name:        "merge_pull_request",
		Description: "Merge a pull request with a squash merge commit.",
		InputSchema: schema(map[string]any{
			"owner":       strProp("Owner login of the repository"),
			"repo":        strProp("Name of the repository"),
			"pull_number": intProp("Number of the pull request to merge"),
		}, []string{"owner", "repo", "pull_number"}),
	},
}

var toolsArrayJSON []byte

func init() {
	b, err := json.Marshal(tools)
	if err != nil {
		panic(err)
	}
	toolsArrayJSON = b
}

// toolResult is the JSON-RPC result of a successful tools/call.
type toolResult struct {
	Content           []contentBlock `json:"content"`
	StructuredContent any            `json:"structuredContent,omitempty"`
	IsError           bool           `json:"isError"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// okResult wraps a plain object as a tool result: the same object as
// human-readable text and as structuredContent.
func okResult(obj any) toolResult {
	b, _ := json.Marshal(obj)
	return toolResult{
		Content:           []contentBlock{{Type: "text", Text: string(b)}},
		StructuredContent: obj,
		IsError:           false,
	}
}

// errResult wraps a message as a failed tool result.
func errResult(msg string) toolResult {
	return toolResult{
		Content: []contentBlock{{Type: "text", Text: msg}},
		IsError: true,
	}
}

// callParams is the decoded params of a tools/call request.
type callParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

// callTool dispatches one tools/call request.
func callTool(s *store.Store, req rpcRequest) (int, []byte) {
	var params callParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return respondErr(req.ID, -32602, "Invalid params: arguments must be an object")
		}
	}
	if params.Arguments == nil {
		params.Arguments = map[string]any{}
	}
	switch params.Name {
	case "get_repo", "list_issues":
		s.Mu.RLock()
		defer s.Mu.RUnlock()
	default:
		known := false
		for _, t := range tools {
			if t.Name == params.Name {
				known = true
				break
			}
		}
		if !known {
			return respondErr(req.ID, -32601, fmt.Sprintf("Unknown tool: %s", params.Name))
		}
		s.Mu.Lock()
		defer s.Mu.Unlock()
	}
	res, rpcErr := runTool(s, params.Name, params.Arguments)
	if rpcErr != nil {
		return respondErr(req.ID, rpcErr.Code, rpcErr.Message)
	}
	return respond(req.ID, res)
}

// runTool executes one known tool. It returns either a tool result or a
// JSON-RPC error (for unknown tools); missing required arguments are
// reported as isError results.
func runTool(s *store.Store, name string, args map[string]any) (toolResult, *rpcError) {
	switch name {
	case "create_repo":
		return toolCreateRepo(s, args), nil
	case "get_repo":
		return toolGetRepo(s, args), nil
	case "create_issue":
		return toolCreateIssue(s, args), nil
	case "list_issues":
		return toolListIssues(s, args), nil
	case "create_pull_request":
		return toolCreatePullRequest(s, args), nil
	case "merge_pull_request":
		return toolMergePullRequest(s, args), nil
	}
	return toolResult{}, &rpcError{Code: -32601, Message: fmt.Sprintf("Unknown tool: %s", name)}
}

// --- argument helpers ------------------------------------------------------

// argStr reads the first present, non-empty string argument among keys.
func argStr(args map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			if s, ok := v.(string); ok && s != "" {
				return s
			}
		}
	}
	return ""
}

func argBool(args map[string]any, keys ...string) bool {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			if b, ok := v.(bool); ok {
				return b
			}
		}
	}
	return false
}

func argInt(args map[string]any, keys ...string) (int, bool) {
	for _, k := range keys {
		if v, ok := args[k]; ok {
			switch t := v.(type) {
			case float64:
				return int(t), true
			case int:
				return t, true
			case string:
				if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
					return n, true
				}
			}
		}
	}
	return 0, false
}

// splitOwnerRepo splits "owner/repo" (a full_name value) into its parts.
func splitOwnerRepo(full string) (string, string, bool) {
	parts := strings.SplitN(full, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// resolveRepoArgs extracts owner + repo from the arguments, accepting the
// canonical names, common synonyms, and a full_name "owner/repo" value.
func resolveRepoArgs(s *store.Store, args map[string]any) (owner, repo string) {
	owner = argStr(args, "owner", "owner_login", "org", "organization", "user", "user_login", "login", "account", "namespace", "owner_name")
	repo = argStr(args, "repo", "repository", "repository_name", "repo_name", "repo_slug", "project", "project_name")
	if repo == "" {
		if full := argStr(args, "full_name", "repo_full_name", "repository_full_name", "fullName"); full != "" {
			if o, r, ok := splitOwnerRepo(full); ok {
				if owner == "" {
					owner = o
				}
				repo = r
			}
		}
	}
	if owner == "" {
		owner = s.ViewerLogin
		if owner == "" {
			owner = s.Token
		}
	}
	return owner, repo
}

func repoSummary(r *store.Repo) map[string]any {
	return map[string]any{
		"id":             r.DatabaseID,
		"name":           r.Name,
		"full_name":      r.Owner + "/" + r.Name,
		"owner":          r.Owner,
		"repo":           r.Name,
		"private":        r.Private,
		"description":    r.Description,
		"default_branch": r.DefaultBranch,
	}
}

// --- tools -----------------------------------------------------------------

func toolCreateRepo(s *store.Store, args map[string]any) toolResult {
	name := argStr(args, "name", "repo", "repository", "repository_name", "repo_name")
	owner := argStr(args, "owner", "owner_login", "org", "organization", "user", "user_login", "login", "account", "namespace", "owner_name")
	if name == "" {
		if full := argStr(args, "full_name", "repo_full_name", "repository_full_name", "fullName"); full != "" {
			if o, r, ok := splitOwnerRepo(full); ok {
				owner, name = o, r
			}
		}
	}
	if name == "" {
		return errResult("missing required argument: name")
	}
	if owner == "" {
		owner = s.ViewerLogin
		if owner == "" {
			owner = s.Token
		}
	}
	if existing := s.GetRepo(owner, name); existing != nil {
		return okResult(repoSummary(existing))
	}
	r := s.CreateRepo(owner, name, argBool(args, "private", "is_private"), argStr(args, "description", "about", "summary", "body"))
	return okResult(repoSummary(r))
}

func toolGetRepo(s *store.Store, args map[string]any) toolResult {
	owner, repo := resolveRepoArgs(s, args)
	if repo == "" {
		return errResult("missing required argument: repo")
	}
	r := s.GetRepo(owner, repo)
	if r == nil {
		return errResult("repository not found: " + owner + "/" + repo)
	}
	return okResult(repoSummary(r))
}

func toolCreateIssue(s *store.Store, args map[string]any) toolResult {
	owner, repo := resolveRepoArgs(s, args)
	title := argStr(args, "title", "issue_title", "pr_title", "pull_request_title", "subject")
	if owner == "" || repo == "" || title == "" {
		return errResult("missing required argument: owner, repo, and title are required")
	}
	r := s.GetRepo(owner, repo)
	if r == nil {
		return errResult("repository not found: " + owner + "/" + repo)
	}
	iss := &store.Issue{
		Number:    r.NextIssue,
		Title:     title,
		Body:      argStr(args, "body", "issue_body", "description", "content", "text", "comment"),
		State:     "open",
		CreatedAt: util.Now(),
		UpdatedAt: util.Now(),
	}
	r.NextIssue++
	r.Issues = append(r.Issues, iss)
	return okResult(map[string]any{
		"number": iss.Number,
		"id":     iss.Number,
		"title":  iss.Title,
		"body":   iss.Body,
		"state":  "open",
		"owner":  owner,
		"repo":   repo,
	})
}

func toolListIssues(s *store.Store, args map[string]any) toolResult {
	owner, repo := resolveRepoArgs(s, args)
	if repo == "" {
		return errResult("missing required argument: repo")
	}
	r := s.GetRepo(owner, repo)
	if r == nil {
		return errResult("repository not found: " + owner + "/" + repo)
	}
	state := strings.ToLower(argStr(args, "state", "status"))
	list := make([]map[string]any, 0)
	for _, iss := range r.Issues {
		if state != "" && state != "all" && iss.State != state {
			continue
		}
		list = append(list, map[string]any{
			"number": iss.Number,
			"id":     iss.Number,
			"title":  iss.Title,
			"body":   iss.Body,
			"state":  iss.State,
		})
	}
	return okResult(map[string]any{"issues": list, "total": len(list)})
}

func toolCreatePullRequest(s *store.Store, args map[string]any) toolResult {
	owner, repo := resolveRepoArgs(s, args)
	title := argStr(args, "title", "issue_title", "pr_title", "pull_request_title", "subject")
	head := argStr(args, "head", "head_ref", "head_branch", "pull_request_head", "pr_head", "source", "source_ref", "source_branch", "from", "from_branch", "branch")
	base := argStr(args, "base", "base_ref", "base_branch", "pull_request_base", "pr_base", "target", "target_ref", "target_branch", "into", "into_branch")
	if owner == "" || repo == "" || title == "" || head == "" || base == "" {
		return errResult("missing required argument: owner, repo, title, head, and base are required")
	}
	r := s.GetRepo(owner, repo)
	if r == nil {
		return errResult("repository not found: " + owner + "/" + repo)
	}
	headSHA := r.Ref("refs/heads/" + head)
	baseSHA := r.Ref("refs/heads/" + base)
	if headSHA == "" || baseSHA == "" {
		return errResult("head or base branch not found")
	}
	headObj := r.GetObject(headSHA)
	baseObj := r.GetObject(baseSHA)
	if headObj == nil || baseObj == nil {
		return errResult("head or base commit not found")
	}
	headTree, _ := git.ParseCommit(headObj.Data)
	baseTree, _ := git.ParseCommit(baseObj.Data)
	files := git.DiffTrees(r, baseTree, headTree)
	pr := &store.Pull{
		Number:    r.NextPull,
		Title:     title,
		Body:      argStr(args, "body", "issue_body", "description", "content", "text", "comment"),
		State:     "open",
		HeadRef:   head,
		HeadSHA:   headSHA,
		BaseRef:   base,
		BaseSHA:   baseSHA,
		Mergeable: "MERGEABLE",
		Files:     files,
	}
	r.NextPull++
	r.Pulls = append(r.Pulls, pr)
	return okResult(map[string]any{
		"number":      pr.Number,
		"pull_number": pr.Number,
		"id":          pr.Number,
		"title":       pr.Title,
		"body":        pr.Body,
		"state":       "open",
		"head":        head,
		"base":        base,
		"head_ref":    head,
		"base_ref":    base,
	})
}

func toolMergePullRequest(s *store.Store, args map[string]any) toolResult {
	owner, repo := resolveRepoArgs(s, args)
	number, hasNumber := argInt(args, "pull_number", "pull_request_number", "pr_number", "number", "issue_number", "index")
	if repo == "" || !hasNumber {
		return errResult("missing required argument: repo and pull_number are required")
	}
	r := s.GetRepo(owner, repo)
	if r == nil {
		return errResult("repository not found: " + owner + "/" + repo)
	}
	var pr *store.Pull
	for _, p := range r.Pulls {
		if p.Number == number {
			pr = p
			break
		}
	}
	if pr == nil {
		return errResult("pull request not found")
	}
	if pr.Mergeable == "CONFLICTING" {
		return errResult("pull request is conflicting and cannot be merged")
	}
	headObj := r.GetObject(pr.HeadSHA)
	if headObj == nil {
		return errResult("head commit not found")
	}
	headTree, _ := git.ParseCommit(headObj.Data)
	baseSHA := r.Ref("refs/heads/" + pr.BaseRef)
	msg := fmt.Sprintf("Merge pull request #%d from %s/%s", pr.Number, r.Owner, pr.HeadRef)
	sha := git.MakeCommit(r, headTree, []string{baseSHA}, msg)
	r.SetRef("refs/heads/"+pr.BaseRef, sha)
	pr.State = "closed"
	pr.Merged = true
	pr.MergedAt = util.Now()
	pr.MergeCommitSHA = sha
	return okResult(map[string]any{
		"merged":      true,
		"number":      pr.Number,
		"pull_number": pr.Number,
		"id":          pr.Number,
		"sha":         sha,
		"message":     msg,
		"state":       "closed",
	})
}
