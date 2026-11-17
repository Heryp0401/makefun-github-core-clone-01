// Upload-pack: protocol v2 advertisement, ls-refs and fetch, plus the
// v0 fallback advertisement used when the client does not ask for v2.
package git

import (
	"bytes"
	"io"
	"net/http"
	"sort"
	"strings"

	"forge/internal/store"
	"forge/internal/util"
)

// refInfo is one reference as advertised: name, target oid, and for
// annotated tags the peeled commit.
type refInfo struct {
	name   string
	oid    string
	peeled string // commit the tag points at; "" when not an annotated tag
	isTag  bool
}

// collectRefs returns the repo's references in advertisement order: HEAD
// first (when the default branch exists), then heads and tags sorted by
// name. Annotated tags carry their peeled commit.
func collectRefs(repo *store.Repo) []refInfo {
	var names []string
	for name := range repo.Refs {
		names = append(names, name)
	}
	sort.Strings(names)
	var out []refInfo
	if tip := repo.Ref("refs/heads/" + repo.DefaultBranch); tip != "" {
		out = append(out, refInfo{name: "HEAD", oid: tip})
	}
	for _, name := range names {
		oid := repo.Refs[name]
		ri := refInfo{name: name, oid: oid}
		if strings.HasPrefix(name, "refs/tags/") {
			ri.isTag = true
			if obj := repo.GetObject(oid); obj != nil && obj.Type == "tag" {
				ri.peeled = parseTagTarget(obj.Data)
			}
		}
		out = append(out, ri)
	}
	return out
}

// advertiseV2 writes the protocol v2 advertisement: service line, flush,
// "version 2", then one capability line each.
func advertiseV2(buf *bytes.Buffer, service string) {
	_ = writePktLine(buf, "# service="+service+"\n")
	writeFlush(buf)
	_ = writePktLine(buf, "version 2\n")
	_ = writePktLine(buf, "ls-refs\n")
	_ = writePktLine(buf, "fetch=shallow unborn\n")
	_ = writePktLine(buf, "object-format=sha1\n")
	writeFlush(buf)
}

// advertiseV0 writes the v0 advertisement: service line, flush, then one
// ref line per reference; the first line carries capabilities after NUL.
// An empty repository advertises the zero oid with capabilities^{}.
func advertiseV0(buf *bytes.Buffer, service string, repo *store.Repo, caps string) {
	_ = writePktLine(buf, "# service="+service+"\n")
	writeFlush(buf)
	refs := collectRefs(repo)
	if len(refs) == 0 {
		_ = writePktLine(buf, zeroOID+" capabilities^{}\x00"+caps+"\n")
		writeFlush(buf)
		return
	}
	for i, r := range refs {
		line := r.oid + " " + r.name
		if i == 0 {
			line += "\x00" + caps
		}
		line += "\n"
		_ = writePktLine(buf, line)
		if r.peeled != "" {
			_ = writePktLine(buf, r.peeled+" "+r.name+"^{}\n")
		}
	}
	writeFlush(buf)
}

// handleInfoRefs answers GET .../info/refs?service=.... Missing repos are
// 404; the server stays up.
func handleInfoRefs(s *store.Store, w http.ResponseWriter, r *http.Request, owner, name string) {
	repo := s.GetRepo(owner, name)
	if repo == nil {
		util.WriteErr(w, http.StatusNotFound, "repository not found")
		return
	}
	service := r.URL.Query().Get("service")
	if service != "git-upload-pack" && service != "git-receive-pack" {
		util.WriteErr(w, http.StatusNotFound, "unknown service")
		return
	}
	var buf bytes.Buffer
	if service == "git-upload-pack" && r.Header.Get("Git-Protocol") == "version=2" {
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		advertiseV2(&buf, service)
	} else if service == "git-upload-pack" {
		w.Header().Set("Content-Type", "application/x-git-upload-pack-advertisement")
		caps := "symref=HEAD:refs/heads/" + repo.DefaultBranch + " side-band-64k"
		advertiseV0(&buf, service, repo, caps)
	} else {
		w.Header().Set("Content-Type", "application/x-git-receive-pack-advertisement")
		caps := "symref=HEAD:refs/heads/" + repo.DefaultBranch + " report-status side-band-64k delete-refs"
		advertiseV0(&buf, service, repo, caps)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// fetchRequest is a parsed protocol v2 fetch / ls-refs request body.
type fetchRequest struct {
	command  string
	wants    []string
	haves    []string
	shallow  []string
	deepen   int
	prefixes []string
	peel     bool
	symrefs  bool
	unborn   bool
}

// parseV2Request parses pkt-lines of a v2 request: the command line, an
// optional agent/object-format section, a delimiter, then arguments.
func parseV2Request(body []byte) (*fetchRequest, error) {
	lines, err := parsePktLines(body)
	if err != nil {
		return nil, err
	}
	req := &fetchRequest{}
	inArgs := false
	for _, l := range lines {
		switch l.kind {
		case pktFlush:
			continue
		case pktDelim:
			inArgs = true
			continue
		}
		text := strings.TrimSuffix(string(l.data), "\n")
		if !inArgs {
			if strings.HasPrefix(text, "command=") {
				req.command = strings.TrimPrefix(text, "command=")
				continue
			}
			// agent= and object-format= lines are ignored. If a
			// negotiation flag or a want/have line shows up before
			// any delimiter, treat the rest as arguments.
			if text == "thin-pack" || text == "no-progress" || text == "ofs-delta" ||
				strings.HasPrefix(text, "want ") || strings.HasPrefix(text, "have ") {
				inArgs = true
			} else {
				continue
			}
		}
		switch {
		case strings.HasPrefix(text, "want "):
			req.wants = append(req.wants, strings.TrimSpace(text[5:]))
		case strings.HasPrefix(text, "have "):
			req.haves = append(req.haves, strings.TrimSpace(text[5:]))
		case strings.HasPrefix(text, "shallow "):
			req.shallow = append(req.shallow, strings.TrimSpace(text[8:]))
		case strings.HasPrefix(text, "deepen "):
			req.deepen = parseUint(strings.TrimSpace(text[7:]))
		case text == "peel":
			req.peel = true
		case text == "symrefs":
			req.symrefs = true
		case text == "unborn":
			req.unborn = true
		case strings.HasPrefix(text, "ref-prefix "):
			req.prefixes = append(req.prefixes, strings.TrimSpace(text[11:]))
		case text == "thin-pack" || text == "no-progress" || text == "ofs-delta" || text == "done":
			// Negotiation flags; thin-pack is irrelevant, packs are
			// always self-contained.
		default:
			if strings.HasPrefix(text, "filter ") {
				// Filters are accepted but not applied: the client
				// tolerates a superset of the objects it asked for.
			}
		}
	}
	return req, nil
}

// parseUint parses a small decimal integer, returning 0 on bad input.
func parseUint(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// matchesPrefixes reports whether ref matches at least one requested
// ref-prefix (no prefixes means everything matches).
func matchesPrefixes(ref string, prefixes []string) bool {
	if len(prefixes) == 0 {
		return true
	}
	for _, p := range prefixes {
		if strings.HasPrefix(ref, p) {
			return true
		}
	}
	return false
}

// handleLsRefs answers a protocol v2 ls-refs request.
func handleLsRefs(s *store.Store, w http.ResponseWriter, repo *store.Repo, req *fetchRequest) {
	s.Mu.RLock()
	var buf bytes.Buffer
	refs := collectRefs(repo)
	for _, r := range refs {
		if !matchesPrefixes(r.name, req.prefixes) {
			continue
		}
		// The client reads the peeled commit from the "peeled:<sha>"
		// attribute on the tag line, so always emit it for annotated
		// tags, and emit the "^{}" line as well.
		line := r.oid + " " + r.name
		if r.name == "HEAD" {
			line += " symref-target:refs/heads/" + repo.DefaultBranch
		}
		if r.peeled != "" {
			line += " peeled:" + r.peeled
		}
		line += "\n"
		_ = writePktLine(&buf, line)
		if r.peeled != "" {
			_ = writePktLine(&buf, r.peeled+" "+r.name+"^{}\n")
		}
	}
	if len(refs) == 0 && req.unborn {
		// Nothing is born yet: report the default branch as unborn.
		branch := "refs/heads/" + repo.DefaultBranch
		if matchesPrefixes("HEAD", req.prefixes) {
			_ = writePktLine(&buf, "unborn HEAD symref-target:"+branch+"\n")
		}
		if matchesPrefixes(branch, req.prefixes) {
			_ = writePktLine(&buf, "unborn "+branch+" symref-target:"+branch+"\n")
		}
	}
	s.Mu.RUnlock()
	writeFlush(&buf)
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// handleFetch answers a protocol v2 fetch request.
func handleFetch(s *store.Store, w http.ResponseWriter, repo *store.Repo, req *fetchRequest) {
	haves := make(map[string]bool, len(req.haves))
	for _, h := range req.haves {
		haves[h] = true
	}
	// Build everything under a read lock, then write to the network
	// after releasing it, so concurrent clones run in parallel.
	s.Mu.RLock()
	// Acknowledgements: ACK every have we hold, then "ready"; NAK
	// when the client sent no haves.
	var buf bytes.Buffer
	_ = writePktLine(&buf, "acknowledgments\n")
	acked := false
	for _, h := range req.haves {
		if repo.GetObject(h) != nil {
			_ = writePktLine(&buf, "ACK "+h+"\n")
			acked = true
		}
	}
	if acked {
		_ = writePktLine(&buf, "ready\n")
	} else {
		_ = writePktLine(&buf, "NAK\n")
	}
	writeFlush(&buf)

	// Head-pack cache: a depth-1 (or full) fetch of the default-branch
	// tip with no haves is the clone workload; reuse the cached pack
	// when the tip and depth still match. Deeper fetches never use the
	// cache: their shallow boundary is not the want itself.
	var pack []byte
	useCache := len(req.wants) == 1 && len(req.haves) == 0 && len(req.shallow) == 0 && req.deepen <= 1
	var tip string
	if useCache {
		tip = repo.Ref("refs/heads/" + repo.DefaultBranch)
		if tip != "" && tip == req.wants[0] && repo.HeadPackTip == tip &&
			repo.HeadPackDeepen == req.deepen && repo.HeadPackBuf != nil {
			pack = repo.HeadPackBuf
		}
	}
	var shallow, unshallow []string
	if pack == nil {
		objs, sh, _ := Reachable(repo, req.wants, haves, req.deepen, req.shallow)
		shallow = sh
		// Commits the client already considers shallow whose parents
		// are now included stop being shallow.
		shallowSet := make(map[string]bool, len(shallow))
		for _, shv := range shallow {
			shallowSet[shv] = true
		}
		for _, old := range req.shallow {
			if !shallowSet[old] {
				unshallow = append(unshallow, old)
			}
		}
		if req.deepen == 0 && len(req.shallow) > 0 && len(shallow) == 0 {
			// No deeper fetch: the client's shallow commits stay
			// shallow; echo them back.
			shallow = append(shallow, req.shallow...)
			unshallow = nil
		}
		pack = BuildPack(objs)
		if useCache && tip != "" {
			// Remember the pack for the next identical clone. The
			// write happens after the read lock is released below.
			defer func(tip string, deepen int, pack []byte) {
				s.Mu.Lock()
				if repo.Ref("refs/heads/"+repo.DefaultBranch) == tip {
					repo.HeadPackTip = tip
					repo.HeadPackDeepen = deepen
					repo.HeadPackBuf = pack
				}
				s.Mu.Unlock()
			}(tip, req.deepen, pack)
		}
	} else if req.deepen == 1 {
		// Cached pack at depth 1: the shallow boundary is the want
		// itself. (Depth 0 has no shallow-info section at all.)
		shallow = append(shallow, req.wants...)
	}
	s.Mu.RUnlock()

	// Shallow-info section, only when a shallow fetch is in play. It
	// MUST be followed by a flush before the packfile section, or the
	// client reads "packfile" as a shallow-info line.
	if req.deepen > 0 || len(req.shallow) > 0 {
		_ = writePktLine(&buf, "shallow-info\n")
		for _, shv := range shallow {
			_ = writePktLine(&buf, "shallow "+shv+"\n")
		}
		for _, un := range unshallow {
			_ = writePktLine(&buf, "unshallow "+un+"\n")
		}
		writeFlush(&buf)
	}
	_ = writePktLine(&buf, "packfile\n")
	sidebandFrame(&buf, pack)
	w.Header().Set("Content-Type", "application/x-git-upload-pack-result")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}

// handleUploadPack dispatches a POST to git-upload-pack: a v2 ls-refs or
// fetch request. A malformed body is a 400, never a crash.
func handleUploadPack(s *store.Store, w http.ResponseWriter, r *http.Request, owner, name string) {
	repo := s.GetRepo(owner, name)
	if repo == nil {
		util.WriteErr(w, http.StatusNotFound, "repository not found")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		util.WriteErr(w, http.StatusBadRequest, "cannot read request")
		return
	}
	req, err := parseV2Request(body)
	if err != nil || req.command == "" {
		util.WriteErr(w, http.StatusBadRequest, "malformed upload-pack request")
		return
	}
	switch req.command {
	case "ls-refs":
		handleLsRefs(s, w, repo, req)
	case "fetch":
		handleFetch(s, w, repo, req)
	default:
		util.WriteErr(w, http.StatusBadRequest, "unknown command")
	}
}
