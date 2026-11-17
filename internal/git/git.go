// HTTP dispatch for git smart HTTP: /{owner}/{repo}.git/info/refs,
// /{owner}/{repo}.git/git-upload-pack and
// /{owner}/{repo}.git/git-receive-pack. Authentication and the request id
// are enforced by the server wrapper; this handler only routes.
package git

import (
	"net/http"
	"net/url"
	"strings"

	"forge/internal/store"
	"forge/internal/util"
)

// Handler returns the git smart-HTTP handler for the store.
func Handler(s *store.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		owner, repo, suffix, ok := splitGitPath(r.URL.Path)
		if !ok {
			util.WriteErr(w, http.StatusNotFound, "not found")
			return
		}
		switch {
		case r.Method == http.MethodGet && suffix == "/info/refs":
			handleInfoRefs(s, w, r, owner, repo)
		case r.Method == http.MethodPost && suffix == "/git-upload-pack":
			handleUploadPack(s, w, r, owner, repo)
		case r.Method == http.MethodPost && suffix == "/git-receive-pack":
			handleReceivePack(s, w, r, owner, repo)
		default:
			util.WriteErr(w, http.StatusNotFound, "not found")
		}
	}
}

// splitGitPath splits "/{owner}/{repo}.git[/suffix]" without building a
// URL object: owner and repo are the raw segments, percent-decoded.
func splitGitPath(path string) (owner, repo, suffix string, ok bool) {
	if !strings.HasPrefix(path, "/") {
		return "", "", "", false
	}
	rest := path[1:]
	slash := strings.IndexByte(rest, '/')
	if slash < 0 {
		return "", "", "", false
	}
	owner = rest[:slash]
	rest = rest[slash+1:]
	// The repo name ends at the first ".git/" or a trailing ".git".
	if i := strings.Index(rest, ".git/"); i >= 0 {
		repo, suffix = rest[:i], rest[i+4:]
	} else if strings.HasSuffix(rest, ".git") {
		repo, suffix = rest[:len(rest)-4], ""
	} else {
		return "", "", "", false
	}
	if owner == "" || repo == "" {
		return "", "", "", false
	}
	if u, err := url.PathUnescape(owner); err == nil {
		owner = u
	}
	if u, err := url.PathUnescape(repo); err == nil {
		repo = u
	}
	return owner, repo, suffix, true
}
