package graphql

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"forge/internal/git"
	"forge/internal/store"
	"forge/internal/util"
)

// Handler returns the GraphQL endpoint: POST /api/graphql. Auth and the
// X-GitHub-Request-Id header are enforced by the server wrapper, so this
// handler assumes an authenticated request. A batched body (a JSON array of
// operations) is answered with an array of per-operation bodies in order.
func Handler(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			util.WriteErr(w, http.StatusBadRequest, "cannot read body")
			return
		}
		trimmed := bytes.TrimSpace(body)
		if len(trimmed) > 0 && trimmed[0] == '[' {
			var ops []rawOperation
			if err := json.Unmarshal(trimmed, &ops); err != nil {
				util.WriteJSONBytes(w, http.StatusOK, []byte(`{"errors":[{"message":"invalid request body"}]}`))
				return
			}
			results := make([]json.RawMessage, len(ops))
			for i, op := range ops {
				results[i] = runOperation(s, op)
			}
			out, err := json.Marshal(results)
			if err != nil {
				util.WriteErr(w, http.StatusInternalServerError, "encode error")
				return
			}
			util.WriteJSONBytes(w, http.StatusOK, out)
			return
		}
		var op rawOperation
		if err := json.Unmarshal(trimmed, &op); err != nil {
			util.WriteJSONBytes(w, http.StatusOK, []byte(`{"errors":[{"message":"invalid request body"}]}`))
			return
		}
		util.WriteJSONBytes(w, http.StatusOK, runOperation(s, op))
	}
}

type rawOperation struct {
	Query         string         `json:"query"`
	Variables     map[string]any `json:"variables"`
	OperationName string         `json:"operationName"`
}

// runOperation parses and executes one operation and returns its response
// bytes. The response is fully built (and marshalled) while the store lock
// is held; the caller writes it to the network afterwards.
func runOperation(s *store.Store, op rawOperation) json.RawMessage {
	doc, err := ParseDocument(op.Query)
	if err != nil {
		b, _ := json.Marshal(map[string]any{"errors": []any{map[string]any{"message": err.Error()}}})
		return b
	}
	target := pickOperation(doc, op.OperationName)
	if target == nil {
		b, _ := json.Marshal(map[string]any{"errors": []any{map[string]any{"message": "unknown operation"}}})
		return b
	}
	if target.Type == "mutation" {
		s.Mu.Lock()
		defer s.Mu.Unlock()
	} else {
		s.Mu.RLock()
		defer s.Mu.RUnlock()
	}
	ex := &executor{store: s, doc: doc, vars: op.Variables}
	if ex.vars == nil {
		ex.vars = map[string]any{}
	}
	for _, vd := range target.VarDefs {
		if _, ok := ex.vars[vd.Name]; !ok && vd.Default != nil {
			ex.vars[vd.Name] = ex.resolveValue(*vd.Default)
		}
	}
	rootType := "Query"
	var root any = queryRoot{}
	if target.Type == "mutation" {
		rootType = "Mutation"
		root = mutationRoot{}
	}
	data := ex.execSelSet(target.SelSet, rootType, root)
	resp := map[string]any{"data": data}
	if len(ex.errs) > 0 {
		resp["errors"] = ex.errs
	}
	b, err := json.Marshal(resp)
	if err != nil {
		return []byte(`{"errors":[{"message":"encode error"}]}`)
	}
	return b
}

func pickOperation(doc *Document, name string) *Operation {
	if name != "" {
		for _, op := range doc.Operations {
			if op.Name == name {
				return op
			}
		}
		return nil
	}
	if len(doc.Operations) > 0 {
		return doc.Operations[0]
	}
	return nil
}

// gqlError is one entry of a GraphQL errors array.
type gqlError struct {
	Message string `json:"message"`
}

// executor carries the per-operation state: the store, the parsed document,
// the operation variables, and the errors collected so far.
type executor struct {
	store *store.Store
	doc   *Document
	vars  map[string]any
	errs  []gqlError
}

func (e *executor) fail(format string, args ...any) {
	e.errs = append(e.errs, gqlError{Message: fmt.Sprintf(format, args...)})
}

// resolveValue turns a parsed value into a plain Go value, substituting
// variables from the operation's variables map.
func (e *executor) resolveValue(v Value) any {
	switch v.Kind {
	case KindNull:
		return nil
	case KindString, KindEnum:
		return v.Str
	case KindInt, KindFloat:
		return v.Num
	case KindBool:
		return v.Bool
	case KindVar:
		if val, ok := e.vars[v.Var]; ok {
			return val
		}
		return nil
	case KindList:
		out := make([]any, 0, len(v.List))
		for _, el := range v.List {
			out = append(out, e.resolveValue(el))
		}
		return out
	case KindObject:
		out := map[string]any{}
		for _, f := range v.Obj {
			out[f.Name] = e.resolveValue(f.Value)
		}
		return out
	}
	return nil
}

func toString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	case json.Number:
		return string(t)
	default:
		return fmt.Sprint(t)
	}
}

func toInt(v any) int {
	switch t := v.(type) {
	case nil:
		return 0
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(t))
		return n
	case json.Number:
		n, _ := t.Int64()
		return int(n)
	default:
		return 0
	}
}

func toBool(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t == "true"
	default:
		return false
	}
}

func toStringSlice(v any) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return []string{t}
	case []any:
		out := make([]string, 0, len(t))
		for _, el := range t {
			out = append(out, toString(el))
		}
		return out
	default:
		return nil
	}
}

// argsMap resolves every argument of a field into a plain map.
func (e *executor) argsMap(f *Field) map[string]any {
	out := map[string]any{}
	for _, a := range f.Args {
		out[a.Name] = e.resolveValue(a.Value)
	}
	return out
}

// --- resolved-value wrappers ---------------------------------------------

type queryRoot struct{}
type mutationRoot struct{}

type userVal struct{ login string }
type repoVal struct{ r *store.Repo }
type refVal struct{ name string }
type issueVal struct {
	r   *store.Repo
	iss *store.Issue
}
type pullVal struct {
	r  *store.Repo
	pr *store.Pull
}
type issuesConn struct {
	r         *store.Repo
	nodes     []*store.Issue
	hasNext   bool
	endCursor string
	hasCursor bool
}
type pullsConn struct {
	r     *store.Repo
	nodes []*store.Pull
}
type filesConn struct{ files []store.PullFile }
type pageInfoVal struct {
	hasNext   bool
	endCursor string
	hasCursor bool
}
type changedFileVal struct{ f store.PullFile }
type typeVal struct{ info *typeInfo }
type fieldVal struct{ name string }
type enumVal struct{ name string }
type createIssuePayload struct {
	r   *store.Repo
	iss *store.Issue
}
type closeIssuePayload struct {
	r   *store.Repo
	iss *store.Issue
}
type createPRPayload struct {
	r  *store.Repo
	pr *store.Pull
}
type mergePRPayload struct {
	r  *store.Repo
	pr *store.Pull
}
type addCommentPayload struct{ c *store.Comment }
type commentEdgeVal struct{ c *store.Comment }
type commentVal struct{ c *store.Comment }

// gqlTypeName returns the GraphQL type name of a resolved wrapper value.
func gqlTypeName(v any) string {
	switch v.(type) {
	case queryRoot:
		return "Query"
	case mutationRoot:
		return "Mutation"
	case userVal:
		return "User"
	case repoVal:
		return "Repository"
	case refVal:
		return "Ref"
	case issueVal:
		return "Issue"
	case pullVal:
		return "PullRequest"
	case issuesConn:
		return "IssueConnection"
	case pullsConn:
		return "PullRequestConnection"
	case filesConn:
		return "PullRequestChangedFileConnection"
	case pageInfoVal:
		return "PageInfo"
	case changedFileVal:
		return "PullRequestChangedFile"
	case typeVal:
		return "__Type"
	case fieldVal:
		return "__Field"
	case enumVal:
		return "__EnumValue"
	case createIssuePayload:
		return "CreateIssuePayload"
	case closeIssuePayload:
		return "CloseIssuePayload"
	case createPRPayload:
		return "CreatePullRequestPayload"
	case mergePRPayload:
		return "MergePullRequestPayload"
	case addCommentPayload:
		return "AddCommentPayload"
	case commentEdgeVal:
		return "CommentEdge"
	case commentVal:
		return "Comment"
	}
	return ""
}

// --- global ids -----------------------------------------------------------

// encodeID builds an opaque, stable global id: base64url("Kind:key").
func encodeID(kind, key string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(kind + ":" + key))
}

// decodeID splits a global id back into its kind and key.
func decodeID(id string) (kind, key string, ok bool) {
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return "", "", false
	}
	i := strings.IndexByte(string(b), ':')
	if i < 0 {
		return "", "", false
	}
	return string(b[:i]), string(b[i+1:]), true
}

func repoID(r *store.Repo) string { return encodeID("Repository", r.Owner+"/"+r.Name) }
func issueID(r *store.Repo, n int) string {
	return encodeID("Issue", r.Owner+"/"+r.Name+":"+strconv.Itoa(n))
}
func pullID(r *store.Repo, n int) string {
	return encodeID("PullRequest", r.Owner+"/"+r.Name+":"+strconv.Itoa(n))
}
func userID(login string) string { return encodeID("User", login) }

// lookupIssue finds an issue by number in a repo, or nil.
func lookupIssue(r *store.Repo, number int) *store.Issue {
	for _, iss := range r.Issues {
		if iss.Number == number {
			return iss
		}
	}
	return nil
}

// lookupPull finds a pull request by number in a repo, or nil.
func lookupPull(r *store.Repo, number int) *store.Pull {
	for _, pr := range r.Pulls {
		if pr.Number == number {
			return pr
		}
	}
	return nil
}

// decodeRepoID resolves a repository global id to its repo, or nil.
func (e *executor) decodeRepoID(id string) *store.Repo {
	kind, key, ok := decodeID(id)
	if !ok || kind != "Repository" {
		return nil
	}
	parts := strings.SplitN(key, "/", 2)
	if len(parts) != 2 {
		return nil
	}
	return e.store.GetRepo(parts[0], parts[1])
}

// decodeIssueID resolves an issue global id to (repo, issue), or nils.
func (e *executor) decodeIssueID(id string) (*store.Repo, *store.Issue) {
	kind, key, ok := decodeID(id)
	if !ok || kind != "Issue" {
		return nil, nil
	}
	i := strings.LastIndex(key, ":")
	if i < 0 {
		return nil, nil
	}
	parts := strings.SplitN(key[:i], "/", 2)
	if len(parts) != 2 {
		return nil, nil
	}
	r := e.store.GetRepo(parts[0], parts[1])
	if r == nil {
		return nil, nil
	}
	return r, lookupIssue(r, toInt(key[i+1:]))
}

// decodePullID resolves a pull-request global id to (repo, pull), or nils.
func (e *executor) decodePullID(id string) (*store.Repo, *store.Pull) {
	kind, key, ok := decodeID(id)
	if !ok || kind != "PullRequest" {
		return nil, nil
	}
	i := strings.LastIndex(key, ":")
	if i < 0 {
		return nil, nil
	}
	parts := strings.SplitN(key[:i], "/", 2)
	if len(parts) != 2 {
		return nil, nil
	}
	r := e.store.GetRepo(parts[0], parts[1])
	if r == nil {
		return nil, nil
	}
	return r, lookupPull(r, toInt(key[i+1:]))
}

// --- cursors ---------------------------------------------------------------

func encodeCursor(number int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("cursor:" + strconv.Itoa(number)))
}

func decodeCursor(c string) (int, bool) {
	b, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return 0, false
	}
	s := string(b)
	if !strings.HasPrefix(s, "cursor:") {
		return 0, false
	}
	n, err := strconv.Atoi(s[len("cursor:"):])
	if err != nil {
		return 0, false
	}
	return n, true
}

// --- selection execution ---------------------------------------------------

// execSelSet executes a selection set against one resolved object and
// returns the response object. A nil object yields nil (the whole subtree
// is null). Unknown fields append an error naming the field and are skipped.
func (e *executor) execSelSet(ss *SelectionSet, typeName string, obj any) any {
	if obj == nil || ss == nil {
		return nil
	}
	out := map[string]any{}
	for _, sel := range ss.Selections {
		switch s := sel.(type) {
		case *Field:
			key := s.Alias
			if key == "" {
				key = s.Name
			}
			v, known := e.resolveField(typeName, obj, s)
			if !known {
				e.fail("Cannot query field %q on type %q.", s.Name, typeName)
				continue
			}
			if s.SelSet != nil {
				v = e.execSub(v, s)
			} else if isWrapper(v) {
				v = nil
			}
			out[key] = v
		case *InlineFragment:
			if s.TypeCond == "" || s.TypeCond == typeName {
				if sub := e.execSelSet(s.SelSet, typeName, obj); sub != nil {
					for k, v := range sub.(map[string]any) {
						out[k] = v
					}
				}
			}
		case *FragmentSpread:
			if fd, ok := e.doc.Fragments[s.Name]; ok {
				if fd.TypeCond == "" || fd.TypeCond == typeName {
					if sub := e.execSelSet(fd.SelSet, typeName, obj); sub != nil {
						for k, v := range sub.(map[string]any) {
							out[k] = v
						}
					}
				}
			}
		}
	}
	return out
}

// execSub executes a field's sub-selection against its resolved value: one
// object, or one object per element of a list.
func (e *executor) execSub(v any, f *Field) any {
	if v == nil {
		return nil
	}
	if list, ok := v.([]any); ok {
		out := make([]any, len(list))
		for i, el := range list {
			out[i] = e.execSelSet(f.SelSet, gqlTypeName(el), el)
		}
		return out
	}
	return e.execSelSet(f.SelSet, gqlTypeName(v), v)
}

func isWrapper(v any) bool {
	switch v.(type) {
	case userVal, repoVal, refVal, issueVal, pullVal, issuesConn, pullsConn,
		filesConn, pageInfoVal, changedFileVal, typeVal, fieldVal, enumVal,
		createIssuePayload, closeIssuePayload, createPRPayload, mergePRPayload,
		addCommentPayload, commentEdgeVal, commentVal:
		return true
	}
	return false
}

// resolveField resolves one field on one object. It returns (value, true),
// or (nil, false) when the field does not exist on the type.
func (e *executor) resolveField(typeName string, obj any, f *Field) (any, bool) {
	args := e.argsMap(f)
	switch typeName {
	case "Query":
		return e.resolveQuery(obj, f, args)
	case "Mutation":
		return e.resolveMutation(obj, f, args)
	case "User":
		if u, ok := obj.(userVal); ok && f.Name == "login" {
			return u.login, true
		}
	case "Repository":
		return e.resolveRepository(obj, f, args)
	case "Ref":
		if r, ok := obj.(refVal); ok && f.Name == "name" {
			return r.name, true
		}
	case "Issue":
		if v, ok := obj.(issueVal); ok {
			switch f.Name {
			case "id":
				return issueID(v.r, v.iss.Number), true
			case "number":
				return v.iss.Number, true
			case "title":
				return v.iss.Title, true
			case "state":
				return issueState(v.iss.State), true
			case "body":
				return v.iss.Body, true
			}
		}
	case "PullRequest":
		return e.resolvePull(obj, f, args)
	case "IssueConnection":
		if v, ok := obj.(issuesConn); ok {
			switch f.Name {
			case "nodes":
				out := make([]any, 0, len(v.nodes))
				for _, iss := range v.nodes {
					out = append(out, issueVal{r: v.r, iss: iss})
				}
				return out, true
			case "pageInfo":
				return pageInfoVal{hasNext: v.hasNext, endCursor: v.endCursor, hasCursor: v.hasCursor}, true
			case "totalCount":
				return len(v.nodes), true
			}
		}
	case "PullRequestConnection":
		if v, ok := obj.(pullsConn); ok && f.Name == "nodes" {
			out := make([]any, 0, len(v.nodes))
			for _, pr := range v.nodes {
				out = append(out, pullVal{r: v.r, pr: pr})
			}
			return out, true
		}
	case "PullRequestChangedFileConnection":
		if v, ok := obj.(filesConn); ok && f.Name == "nodes" {
			out := make([]any, 0, len(v.files))
			for _, pf := range v.files {
				out = append(out, changedFileVal{f: pf})
			}
			return out, true
		}
	case "PageInfo":
		if v, ok := obj.(pageInfoVal); ok {
			switch f.Name {
			case "hasNextPage":
				return v.hasNext, true
			case "endCursor":
				if v.hasCursor {
					return v.endCursor, true
				}
				return nil, true
			}
		}
	case "PullRequestChangedFile":
		if v, ok := obj.(changedFileVal); ok && f.Name == "path" {
			return v.f.Filename, true
		}
	case "__Type":
		return e.resolveType(obj, f, args)
	case "__Field":
		if v, ok := obj.(fieldVal); ok && f.Name == "name" {
			return v.name, true
		}
	case "__EnumValue":
		if v, ok := obj.(enumVal); ok && f.Name == "name" {
			return v.name, true
		}
	case "CreateIssuePayload":
		if v, ok := obj.(createIssuePayload); ok && f.Name == "issue" {
			if v.iss == nil {
				return nil, true
			}
			return issueVal{r: v.r, iss: v.iss}, true
		}
	case "CloseIssuePayload":
		if v, ok := obj.(closeIssuePayload); ok && f.Name == "issue" {
			if v.iss == nil {
				return nil, true
			}
			return issueVal{r: v.r, iss: v.iss}, true
		}
	case "CreatePullRequestPayload":
		if v, ok := obj.(createPRPayload); ok && f.Name == "pullRequest" {
			if v.pr == nil {
				return nil, true
			}
			return pullVal{r: v.r, pr: v.pr}, true
		}
	case "MergePullRequestPayload":
		if v, ok := obj.(mergePRPayload); ok && f.Name == "pullRequest" {
			if v.pr == nil {
				return nil, true
			}
			return pullVal{r: v.r, pr: v.pr}, true
		}
	case "AddCommentPayload":
		if v, ok := obj.(addCommentPayload); ok {
			switch f.Name {
			case "commentEdge":
				if v.c == nil {
					return nil, true
				}
				return commentEdgeVal{c: v.c}, true
			case "comment":
				if v.c == nil {
					return nil, true
				}
				return commentVal{c: v.c}, true
			}
		}
	case "CommentEdge":
		if v, ok := obj.(commentEdgeVal); ok && f.Name == "node" {
			return commentVal{c: v.c}, true
		}
	case "Comment":
		if v, ok := obj.(commentVal); ok {
			switch f.Name {
			case "id":
				return encodeID("Comment", strconv.Itoa(v.c.ID)), true
			case "body":
				return v.c.Body, true
			}
		}
	}
	return nil, false
}

func issueState(state string) string {
	if state == "closed" {
		return "CLOSED"
	}
	return "OPEN"
}

func pullState(pr *store.Pull) string {
	if pr.State == "closed" {
		return "CLOSED"
	}
	return "OPEN"
}

// resolveQuery handles the root Query fields.
func (e *executor) resolveQuery(obj any, f *Field, args map[string]any) (any, bool) {
	switch f.Name {
	case "viewer":
		login := e.store.ViewerLogin
		if login == "" {
			login = e.store.Token
		}
		return userVal{login: login}, true
	case "repository":
		r := e.store.GetRepo(toString(args["owner"]), toString(args["name"]))
		if r == nil {
			return nil, true
		}
		return repoVal{r: r}, true
	case "node":
		return e.resolveNode(toString(args["id"])), true
	case "__type":
		info := typeRegistry[toString(args["name"])]
		if info == nil {
			return nil, true
		}
		return typeVal{info: info}, true
	}
	return nil, false
}

// resolveNode decodes a global id and dispatches on its kind prefix.
func (e *executor) resolveNode(id string) any {
	kind, key, ok := decodeID(id)
	if !ok {
		return nil
	}
	switch kind {
	case "Repository":
		parts := strings.SplitN(key, "/", 2)
		if len(parts) != 2 {
			return nil
		}
		if r := e.store.GetRepo(parts[0], parts[1]); r != nil {
			return repoVal{r: r}
		}
	case "Issue":
		if r, iss := e.decodeIssueID(id); iss != nil {
			return issueVal{r: r, iss: iss}
		}
	case "PullRequest":
		if r, pr := e.decodePullID(id); pr != nil {
			return pullVal{r: r, pr: pr}
		}
	case "User":
		return userVal{login: key}
	}
	return nil
}

// resolveRepository handles the Repository fields.
func (e *executor) resolveRepository(obj any, f *Field, args map[string]any) (any, bool) {
	v, ok := obj.(repoVal)
	if !ok {
		return nil, false
	}
	r := v.r
	switch f.Name {
	case "id":
		return repoID(r), true
	case "databaseId":
		return r.DatabaseID, true
	case "name":
		return r.Name, true
	case "nameWithOwner":
		return r.Owner + "/" + r.Name, true
	case "owner":
		return userVal{login: r.Owner}, true
	case "defaultBranchRef":
		return refVal{name: r.DefaultBranch}, true
	case "viewerPermission":
		return "ADMIN", true
	case "hasIssuesEnabled":
		return true, true
	case "description":
		return r.Description, true
	case "isPrivate":
		return r.Private, true
	case "issue":
		iss := lookupIssue(r, toInt(args["number"]))
		if iss == nil {
			return nil, true
		}
		return issueVal{r: r, iss: iss}, true
	case "issues":
		return e.resolveIssues(r, args), true
	case "pullRequests":
		first := toInt(args["first"])
		nodes := make([]*store.Pull, 0, len(r.Pulls))
		for _, pr := range r.Pulls {
			nodes = append(nodes, pr)
			if first > 0 && len(nodes) >= first {
				break
			}
		}
		return pullsConn{r: r, nodes: nodes}, true
	case "pullRequest":
		pr := lookupPull(r, toInt(args["number"]))
		if pr == nil {
			return nil, true
		}
		return pullVal{r: r, pr: pr}, true
	}
	return nil, false
}

// resolveIssues builds an IssueConnection: states filter, CREATED_AT
// ordering (number DESC for DESC, number ASC for ASC — all timestamps are
// equal, so the number is the tie-break), and cursor pagination.
func (e *executor) resolveIssues(r *store.Repo, args map[string]any) issuesConn {
	states := toStringSlice(args["states"])
	wantOpen, wantClosed := true, true
	if len(states) > 0 {
		wantOpen, wantClosed = false, false
		for _, st := range states {
			switch strings.ToUpper(st) {
			case "OPEN":
				wantOpen = true
			case "CLOSED":
				wantClosed = true
			}
		}
	}
	desc := true
	if ob, ok := args["orderBy"].(map[string]any); ok {
		if d, ok := ob["direction"]; ok {
			desc = strings.ToUpper(toString(d)) != "ASC"
		}
	}
	after := -1
	afterSet := false
	if c, ok := args["after"]; ok && c != nil {
		if n, ok2 := decodeCursor(toString(c)); ok2 {
			after, afterSet = n, true
		}
	}
	// Collect in the requested order.
	var ordered []*store.Issue
	if desc {
		for i := len(r.Issues) - 1; i >= 0; i-- {
			ordered = append(ordered, r.Issues[i])
		}
	} else {
		ordered = append(ordered, r.Issues...)
	}
	var filtered []*store.Issue
	for _, iss := range ordered {
		if iss.State == "closed" && !wantClosed {
			continue
		}
		if iss.State != "closed" && !wantOpen {
			continue
		}
		if afterSet {
			if desc && iss.Number >= after {
				continue
			}
			if !desc && iss.Number <= after {
				continue
			}
		}
		filtered = append(filtered, iss)
	}
	first := toInt(args["first"])
	if first <= 0 {
		first = len(filtered)
	}
	conn := issuesConn{r: r}
	if len(filtered) > first {
		conn.nodes = filtered[:first]
		conn.hasNext = true
	} else {
		conn.nodes = filtered
		conn.hasNext = false
	}
	if len(conn.nodes) > 0 {
		conn.endCursor = encodeCursor(conn.nodes[len(conn.nodes)-1].Number)
		conn.hasCursor = true
	}
	return conn
}

// resolvePull handles the PullRequest fields.
func (e *executor) resolvePull(obj any, f *Field, args map[string]any) (any, bool) {
	v, ok := obj.(pullVal)
	if !ok {
		return nil, false
	}
	pr := v.pr
	switch f.Name {
	case "id":
		return pullID(v.r, pr.Number), true
	case "number":
		return pr.Number, true
	case "title":
		return pr.Title, true
	case "body":
		return pr.Body, true
	case "state":
		return pullState(pr), true
	case "merged":
		return pr.Merged, true
	case "headRefName":
		return pr.HeadRef, true
	case "baseRefName":
		return pr.BaseRef, true
	case "mergeable":
		if pr.Mergeable != "" {
			return pr.Mergeable, true
		}
		return "MERGEABLE", true
	case "mergedAt":
		return pr.MergedAt, true
	case "mergeCommit":
		if pr.MergeCommitSHA == "" {
			return nil, true
		}
		return pr.MergeCommitSHA, true
	case "files":
		first := toInt(args["first"])
		files := pr.Files
		if first > 0 && len(files) > first {
			files = files[:first]
		}
		return filesConn{files: files}, true
	}
	return nil, false
}

// --- introspection ---------------------------------------------------------

// typeInfo is one static schema entry for __type introspection. No schema
// engine is built: the few types the suite introspects are listed here.
type typeInfo struct {
	name       string
	kind       string
	fields     []string
	enumValues []string
}

var typeRegistry = map[string]*typeInfo{
	"Query":                  {name: "Query", kind: "OBJECT", fields: []string{"viewer", "repository", "node", "__type", "__schema"}},
	"Mutation":               {name: "Mutation", kind: "OBJECT", fields: []string{"createIssue", "closeIssue", "createPullRequest", "mergePullRequest", "addComment"}},
	"User":                   {name: "User", kind: "OBJECT", fields: []string{"id", "login", "name", "url"}},
	"Repository":             {name: "Repository", kind: "OBJECT", fields: []string{"id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "isPrivate", "defaultBranch", "url", "createdAt", "updatedAt"}},
	"Issue":                  {name: "Issue", kind: "OBJECT", fields: []string{"id", "number", "title", "state", "body", "url", "createdAt", "updatedAt", "author", "labels", "comments", "repository"}},
	"PullRequest":            {name: "PullRequest", kind: "OBJECT", fields: []string{"id", "number", "title", "body", "state", "merged", "headRefName", "baseRefName", "mergeable", "files", "url", "createdAt", "updatedAt", "author", "headRef", "baseRef", "mergedAt", "mergeCommit"}},
	"SearchType":             {name: "SearchType", kind: "ENUM", enumValues: []string{"ISSUE", "REPOSITORY", "USER", "DISCUSSION", "COMMIT", "CODE", "MILESTONE", "PACKAGE", "PROJECT", "WIKI"}},
	"IssueState":             {name: "IssueState", kind: "ENUM", enumValues: []string{"OPEN", "CLOSED"}},
	"IssueOrderField":        {name: "IssueOrderField", kind: "ENUM", enumValues: []string{"CREATED_AT", "UPDATED_AT", "COMMENTS"}},
	"OrderDirection":         {name: "OrderDirection", kind: "ENUM", enumValues: []string{"ASC", "DESC"}},
	"MergeableState":         {name: "MergeableState", kind: "ENUM", enumValues: []string{"MERGEABLE", "CONFLICTING", "UNKNOWN"}},
	"PullRequestState":       {name: "PullRequestState", kind: "ENUM", enumValues: []string{"OPEN", "CLOSED", "MERGED"}},
	"PullRequestMergeMethod": {name: "PullRequestMergeMethod", kind: "ENUM", enumValues: []string{"MERGE", "SQUASH", "REBASE"}},
	"RepositoryPermission":   {name: "RepositoryPermission", kind: "ENUM", enumValues: []string{"ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"}},
}

// resolveType handles the __Type fields.
func (e *executor) resolveType(obj any, f *Field, args map[string]any) (any, bool) {
	v, ok := obj.(typeVal)
	if !ok {
		return nil, false
	}
	switch f.Name {
	case "name":
		return v.info.name, true
	case "kind":
		return v.info.kind, true
	case "description":
		return nil, true
	case "fields":
		out := make([]any, 0, len(v.info.fields))
		for _, name := range v.info.fields {
			out = append(out, fieldVal{name: name})
		}
		return out, true
	case "enumValues":
		out := make([]any, 0, len(v.info.enumValues))
		for _, name := range v.info.enumValues {
			out = append(out, enumVal{name: name})
		}
		return out, true
	}
	return nil, false
}

// --- mutations -------------------------------------------------------------

// inputMap extracts the "input" argument as a plain map.
func inputMap(args map[string]any) map[string]any {
	if m, ok := args["input"].(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func (e *executor) resolveMutation(obj any, f *Field, args map[string]any) (any, bool) {
	switch f.Name {
	case "createIssue":
		return e.mutCreateIssue(inputMap(args)), true
	case "closeIssue":
		return e.mutCloseIssue(inputMap(args)), true
	case "createPullRequest":
		return e.mutCreatePullRequest(inputMap(args)), true
	case "mergePullRequest":
		return e.mutMergePullRequest(inputMap(args)), true
	case "addComment":
		return e.mutAddComment(inputMap(args)), true
	}
	return nil, false
}

func (e *executor) mutCreateIssue(input map[string]any) createIssuePayload {
	r := e.decodeRepoID(toString(input["repositoryId"]))
	if r == nil {
		e.fail("repository not found: %s", toString(input["repositoryId"]))
		return createIssuePayload{}
	}
	iss := &store.Issue{
		Number:    r.NextIssue,
		Title:     toString(input["title"]),
		Body:      toString(input["body"]),
		State:     "open",
		CreatedAt: util.Now(),
		UpdatedAt: util.Now(),
	}
	r.NextIssue++
	r.Issues = append(r.Issues, iss)
	return createIssuePayload{r: r, iss: iss}
}

func (e *executor) mutCloseIssue(input map[string]any) closeIssuePayload {
	r, iss := e.decodeIssueID(toString(input["issueId"]))
	if iss == nil {
		e.fail("issue not found: %s", toString(input["issueId"]))
		return closeIssuePayload{}
	}
	iss.State = "closed"
	iss.UpdatedAt = util.Now()
	iss.JSON = nil
	return closeIssuePayload{r: r, iss: iss}
}

func (e *executor) mutCreatePullRequest(input map[string]any) createPRPayload {
	r := e.decodeRepoID(toString(input["repositoryId"]))
	if r == nil {
		e.fail("repository not found: %s", toString(input["repositoryId"]))
		return createPRPayload{}
	}
	headRef := toString(input["headRefName"])
	baseRef := toString(input["baseRefName"])
	headSHA := r.Ref("refs/heads/" + headRef)
	baseSHA := r.Ref("refs/heads/" + baseRef)
	if headSHA == "" || baseSHA == "" {
		e.fail("head or base branch not found")
		return createPRPayload{}
	}
	headObj := r.GetObject(headSHA)
	baseObj := r.GetObject(baseSHA)
	if headObj == nil || baseObj == nil {
		e.fail("head or base commit not found")
		return createPRPayload{}
	}
	headTree, _ := git.ParseCommit(headObj.Data)
	baseTree, _ := git.ParseCommit(baseObj.Data)
	files := git.DiffTrees(r, baseTree, headTree)
	pr := &store.Pull{
		Number:    r.NextPull,
		Title:     toString(input["title"]),
		Body:      toString(input["body"]),
		State:     "open",
		HeadRef:   headRef,
		HeadSHA:   headSHA,
		BaseRef:   baseRef,
		BaseSHA:   baseSHA,
		Mergeable: "MERGEABLE",
		Files:     files,
	}
	r.NextPull++
	r.Pulls = append(r.Pulls, pr)
	return createPRPayload{r: r, pr: pr}
}

func (e *executor) mutMergePullRequest(input map[string]any) mergePRPayload {
	r, pr := e.decodePullID(toString(input["pullRequestId"]))
	if pr == nil {
		e.fail("pull request not found: %s", toString(input["pullRequestId"]))
		return mergePRPayload{}
	}
	if pr.Mergeable == "CONFLICTING" {
		e.fail("pull request is conflicting and cannot be merged")
		return mergePRPayload{}
	}
	headObj := r.GetObject(pr.HeadSHA)
	if headObj == nil {
		e.fail("head commit not found")
		return mergePRPayload{}
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
	return mergePRPayload{r: r, pr: pr}
}

func (e *executor) mutAddComment(input map[string]any) addCommentPayload {
	r, iss := e.decodeIssueID(toString(input["subjectId"]))
	if iss == nil {
		e.fail("issue not found: %s", toString(input["subjectId"]))
		return addCommentPayload{}
	}
	c := &store.Comment{
		ID:        r.NextCommentID,
		Body:      toString(input["body"]),
		CreatedAt: util.Now(),
		UpdatedAt: util.Now(),
	}
	r.NextCommentID++
	iss.Comments = append(iss.Comments, c)
	iss.JSON = nil
	return addCommentPayload{c: c}
}
