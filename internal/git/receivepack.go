// Receive-pack: protocol v0 push handling. The request is pkt-line
// ref-update commands, a flush, then raw pack bytes. Each ref is checked
// for fast-forward; ok refs are applied, refused refs are reported with
// "ng <ref> non-fast-forward", and the report goes back framed on
// sideband band 1.
package git

import (
	"bytes"
	"io"
	"net/http"
	"strings"

	"forge/internal/store"
	"forge/internal/util"
)

// pushCommand is one "<old> <new> <ref>" line from a push request.
type pushCommand struct {
	old string
	new string
	ref string
}

// parsePushCommands decodes the pkt-line command section at the start of
// a receive-pack body and returns the commands plus the offset where the
// raw pack bytes begin.
func parsePushCommands(body []byte) ([]pushCommand, int, error) {
	lines, err := parsePktLinesPrefix(body)
	if err != nil {
		return nil, 0, err
	}
	var cmds []pushCommand
	pos := 0
	for _, l := range lines {
		pos = l.end
		if l.line.kind != pktData {
			continue
		}
		text := string(l.line.data)
		// The first line may carry capabilities after a NUL byte.
		if i := strings.IndexByte(text, 0); i >= 0 {
			text = text[:i]
		}
		text = strings.TrimSuffix(text, "\n")
		fields := strings.Fields(text)
		if len(fields) != 3 {
			return nil, 0, errBadPushCommand
		}
		cmds = append(cmds, pushCommand{old: fields[0], new: fields[1], ref: fields[2]})
	}
	return cmds, pos, nil
}

// errBadPushCommand is returned for a command line that is not three fields.
var errBadPushCommand = &pushError{"bad push command line"}

type pushError struct{ msg string }

func (e *pushError) Error() string { return e.msg }

// parsedPktLine pairs a parsed line with the offset just past it.
type parsedPktLine struct {
	line pktLine
	end  int
}

// parsePktLinesPrefix parses pkt-lines from the start of data until the
// first flush packet, and returns them with end offsets. Parsing stops
// at the flush: everything after it is the raw pack.
func parsePktLinesPrefix(data []byte) ([]parsedPktLine, error) {
	var out []parsedPktLine
	pos := 0
	for pos < len(data) {
		if len(data)-pos < 4 {
			return nil, errBadPushCommand
		}
		n := 0
		for _, c := range data[pos : pos+4] {
			n <<= 4
			switch {
			case c >= '0' && c <= '9':
				n |= int(c - '0')
			case c >= 'a' && c <= 'f':
				n |= int(c-'a') + 10
			case c >= 'A' && c <= 'F':
				n |= int(c-'A') + 10
			default:
				return nil, errBadPushCommand
			}
		}
		if n == 0 {
			out = append(out, parsedPktLine{line: pktLine{kind: pktFlush}, end: pos + 4})
			return out, nil
		}
		if n == 1 {
			out = append(out, parsedPktLine{line: pktLine{kind: pktDelim}, end: pos + 4})
			pos += 4
			continue
		}
		if n < 4 || pos+n > len(data) {
			return nil, errBadPushCommand
		}
		out = append(out, parsedPktLine{line: pktLine{kind: pktData, data: data[pos+4 : pos+n]}, end: pos + n})
		pos += n
	}
	return nil, errBadPushCommand
}

// handleReceivePack answers a POST to git-receive-pack.
func handleReceivePack(s *store.Store, w http.ResponseWriter, r *http.Request, owner, name string) {
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
	cmds, packOff, err := parsePushCommands(body)
	if err != nil {
		util.WriteErr(w, http.StatusBadRequest, "malformed receive-pack request")
		return
	}
	// A create/update command list always carries a pack (possibly an
	// empty one); a delete-only list carries none.
	needsPack := false
	for _, c := range cmds {
		if c.new != zeroOID {
			needsPack = true
			break
		}
	}
	unpackOK := true
	if needsPack {
		if packOff > len(body) {
			unpackOK = false
		} else if objs, perr := ParsePack(body[packOff:]); perr != nil {
			unpackOK = false
		} else {
			s.Mu.Lock()
			for _, o := range objs {
				repo.PutObject(o.Type, o.Data)
			}
			s.Mu.Unlock()
		}
	}

	// Evaluate and apply the ref updates under the write lock.
	type verdict struct {
		cmd pushCommand
		ok  bool
	}
	verdicts := make([]verdict, len(cmds))
	s.Mu.Lock()
	for i, c := range cmds {
		verdicts[i] = verdict{cmd: c}
		if !unpackOK {
			continue
		}
		cur := repo.Ref(c.ref)
		switch {
		case c.new == zeroOID:
			// Delete: old must match the current ref.
			if cur == "" || cur != c.old {
				continue
			}
			delete(repo.Refs, c.ref)
			verdicts[i].ok = true
		case c.old == zeroOID:
			// Create: the ref must not exist yet.
			if cur != "" {
				continue
			}
			if repo.GetObject(c.new) == nil {
				continue
			}
			repo.SetRef(c.ref, c.new)
			verdicts[i].ok = true
		default:
			// Update: old must match, and new must descend from old.
			if cur != c.old {
				continue
			}
			if repo.GetObject(c.new) == nil {
				continue
			}
			if !IsAncestor(repo, c.old, c.new) {
				continue
			}
			repo.SetRef(c.ref, c.new)
			verdicts[i].ok = true
		}
		if verdicts[i].ok && c.ref == "refs/heads/"+repo.DefaultBranch {
			// A new commit on the default branch invalidates the
			// cached head pack.
			repo.HeadPackBuf = nil
			repo.HeadPackTip = ""
			repo.HeadPackDeepen = 0
		}
	}
	s.Mu.Unlock()

	// The report is itself pkt-framed, carried on sideband band 1.
	var report bytes.Buffer
	if unpackOK {
		_ = writePktLine(&report, "unpack ok\n")
	} else {
		_ = writePktLine(&report, "unpack failed\n")
	}
	for _, v := range verdicts {
		if v.ok {
			_ = writePktLine(&report, "ok "+v.cmd.ref+"\n")
		} else if !unpackOK {
			_ = writePktLine(&report, "ng "+v.cmd.ref+" unpack failed\n")
		} else {
			_ = writePktLine(&report, "ng "+v.cmd.ref+" non-fast-forward\n")
		}
	}
	writeFlush(&report)
	var out bytes.Buffer
	sidebandFrame(&out, report.Bytes())
	w.Header().Set("Content-Type", "application/x-git-receive-pack-result")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(out.Bytes())
}
