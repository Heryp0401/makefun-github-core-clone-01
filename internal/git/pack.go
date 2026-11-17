// Packfile layer: building packs (full objects only, deflate level 1),
// parsing packs (including ofs-delta and ref-delta resolution), and the
// reachability walks that decide which objects a fetch must send.
package git

import (
	"bytes"
	"compress/flate"
	"compress/zlib"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/adler32"
	"io"
	"sort"

	"forge/internal/store"
)

// Git object type codes inside a packfile.
const (
	packCommit   = 1
	packTree     = 2
	packBlob     = 3
	packTag      = 4
	packOfsDelta = 6
	packRefDelta = 7
)

// typeName converts a pack type code to the loose-object type name.
func typeName(code int) string {
	switch code {
	case packCommit:
		return "commit"
	case packTree:
		return "tree"
	case packBlob:
		return "blob"
	case packTag:
		return "tag"
	}
	return ""
}

// typeCode converts a loose-object type name to its pack code.
func typeCode(typ string) int {
	switch typ {
	case "commit":
		return packCommit
	case "tree":
		return packTree
	case "blob":
		return packBlob
	case "tag":
		return packTag
	}
	return 0
}

// BuildPack serialises objects as a packfile: "PACK", version 2, count,
// then per object a type/size varint plus a zlib stream at BestSpeed, and
// a trailing SHA-1 of everything before it. Objects are emitted in SHA
// order so the bytes are deterministic for a given object set. No deltas:
// fetch packs are always self-contained.
func BuildPack(objs []*store.Object) []byte {
	// Sort a copy by object id for deterministic output.
	sorted := make([]*store.Object, len(objs))
	copy(sorted, objs)
	sort.Slice(sorted, func(i, j int) bool {
		return hashBytes(sorted[i].Type, sorted[i].Data) < hashBytes(sorted[j].Type, sorted[j].Data)
	})
	// Rough capacity: header + per object a small header + compressed data.
	capEst := 12 + 20
	for _, o := range sorted {
		capEst += 16 + len(o.Data)/2 + 32
	}
	out := make([]byte, 0, capEst)
	out = append(out, 'P', 'A', 'C', 'K')
	var tmp [8]byte
	binary.BigEndian.PutUint32(tmp[:4], 2)
	binary.BigEndian.PutUint32(tmp[4:8], uint32(len(sorted)))
	out = append(out, tmp[:]...)

	var zbuf bytes.Buffer
	zw, err := newBestSpeedWriter(&zbuf)
	if err != nil {
		zw = nil
	}
	for _, o := range sorted {
		out = appendTypeSize(out, typeCode(o.Type), len(o.Data))
		zbuf.Reset()
		if zw == nil {
			zw, _ = newBestSpeedWriter(&zbuf)
		} else {
			zw.Reset(&zbuf)
		}
		_, _ = zw.Write(o.Data)
		_ = zw.Close()
		out = append(out, zbuf.Bytes()...)
	}
	sum := sha1.Sum(out)
	out = append(out, sum[:]...)
	return out
}

// newBestSpeedWriter builds a zlib writer at level 1 over w.
func newBestSpeedWriter(w io.Writer) (flateWriter, error) {
	return zlib.NewWriterLevel(w, zlib.BestSpeed)
}

// flateWriter is the minimal writer interface BuildPack needs: the zlib
// writer's Write, Close and Reset.
type flateWriter interface {
	Write([]byte) (int, error)
	Close() error
	Reset(io.Writer)
}

// appendTypeSize appends a pack object header (type + size varint).
func appendTypeSize(out []byte, typ int, size int) []byte {
	n := size
	b0 := byte(typ<<4) | byte(n&0x0f)
	n >>= 4
	if n > 0 {
		b0 |= 0x80
	}
	out = append(out, b0)
	for n > 0 {
		b := byte(n & 0x7f)
		n >>= 7
		if n > 0 {
			b |= 0x80
		}
		out = append(out, b)
	}
	return out
}

// rawPackEntry is one object parsed from a packfile before delta
// resolution: either a full object (data set) or a delta (delta set).
type rawPackEntry struct {
	offset     int
	typ        int // full-object type, or packOfsDelta / packRefDelta
	data       []byte
	sha        string
	baseOffset int
	baseSHA    string
	delta      []byte
}

// ParsePack decodes a whole packfile into objects, resolving any deltas.
// The input is expected to be complete; a truncated or corrupt pack is an
// error, never a partial result.
func ParsePack(data []byte) ([]*store.Object, error) {
	if len(data) < 12 || string(data[:4]) != "PACK" {
		return nil, errors.New("not a packfile")
	}
	if binary.BigEndian.Uint32(data[4:8]) != 2 {
		return nil, errors.New("unsupported pack version")
	}
	count := int(binary.BigEndian.Uint32(data[8:12]))
	entries := make([]*rawPackEntry, 0, count)
	pos := 12
	for i := 0; i < count; i++ {
		entry, next, err := parsePackObject(data, pos)
		if err != nil {
			return nil, fmt.Errorf("pack object %d at %d: %w", i, pos, err)
		}
		entries = append(entries, entry)
		pos = next
	}
	if pos+20 > len(data) {
		return nil, errors.New("pack truncated before trailer")
	}
	// Trailer must be the SHA-1 of everything before it.
	if sum := sha1.Sum(data[:pos]); !bytes.Equal(sum[:], data[pos:pos+20]) {
		return nil, errors.New("pack trailer checksum mismatch")
	}
	return resolvePackEntries(entries)
}

// parsePackObject decodes one object starting at pos and returns it plus
// the offset of the next object.
func parsePackObject(data []byte, pos int) (*rawPackEntry, int, error) {
	start := pos
	if pos >= len(data) {
		return nil, 0, errors.New("unexpected end of pack")
	}
	// Type/size varint: low 4 bits of size in the first byte, then 7
	// bits per byte, MSB set except on the last byte.
	b := data[pos]
	pos++
	typ := int(b>>4) & 7
	size := int64(b & 0x0f)
	shift := uint(4)
	for b&0x80 != 0 {
		if pos >= len(data) {
			return nil, 0, errors.New("truncated object header")
		}
		b = data[pos]
		pos++
		size |= int64(b&0x7f) << shift
		shift += 7
		if shift > 63 {
			return nil, 0, errors.New("object size varint too long")
		}
	}
	if size < 0 || size > 1<<28 {
		return nil, 0, fmt.Errorf("implausible object size %d", size)
	}
	entry := &rawPackEntry{offset: start, typ: typ}
	if typ == packOfsDelta {
		if pos >= len(data) {
			return nil, 0, errors.New("truncated ofs-delta header")
		}
		b = data[pos]
		pos++
		off := int64(b & 0x7f)
		for b&0x80 != 0 {
			if pos >= len(data) {
				return nil, 0, errors.New("truncated ofs-delta offset")
			}
			b = data[pos]
			pos++
			off = ((off + 1) << 7) | int64(b&0x7f)
		}
		entry.baseOffset = start - int(off)
		if entry.baseOffset < 0 {
			return nil, 0, errors.New("ofs-delta base before pack start")
		}
	} else if typ == packRefDelta {
		if pos+20 > len(data) {
			return nil, 0, errors.New("truncated ref-delta header")
		}
		entry.baseSHA = hex.EncodeToString(data[pos : pos+20])
		pos += 20
	} else if typeName(typ) == "" {
		return nil, 0, fmt.Errorf("unknown pack object type %d", typ)
	}
	// Inflate the zlib stream starting at pos. flate reads through a
	// counting byte reader, so it can only pull bytes one at a time and
	// never buffers ahead; the consumed count plus an Adler-32 trailer
	// check then pins down the exact stream end.
	raw, next, err := inflatePackStream(data, pos, size)
	if err != nil {
		return nil, 0, err
	}
	if entry.typ == packOfsDelta || entry.typ == packRefDelta {
		entry.delta = raw
	} else {
		entry.data = raw
		entry.sha = hashBytes(typeName(typ), raw)
	}
	return entry, next, nil
}

// inflatePackStream inflates one zlib stream at data[pos:] whose
// uncompressed size is size, and returns the bytes plus the offset just
// past the stream (header + deflate + Adler-32 trailer).
func inflatePackStream(data []byte, pos int, size int64) ([]byte, int, error) {
	if pos+2 > len(data) {
		return nil, 0, errors.New("truncated zlib header")
	}
	// Validate the zlib header: compression method 8, correct check
	// bits, no preset dictionary (git never uses one).
	cmf, flg := data[pos], data[pos+1]
	if cmf&0x0f != 8 || (int(cmf)*256+int(flg))%31 != 0 || flg&0x20 != 0 {
		return nil, 0, errors.New("bad zlib header")
	}
	ctr := &countingByteReader{data: data[pos+2:]}
	fr := flate.NewReader(ctr)
	out := make([]byte, size)
	if size > 0 {
		if _, err := io.ReadFull(fr, out); err != nil {
			_ = fr.Close()
			return nil, 0, fmt.Errorf("inflate failed: %w", err)
		}
	}
	if err := fr.Close(); err != nil {
		return nil, 0, fmt.Errorf("inflate close failed: %w", err)
	}
	want := adler32.Checksum(out)
	// The stream ends 4 trailer bytes after the deflate data. flate
	// may have pulled a few bytes past the deflate end into its bit
	// buffer, so the true end is within a small window behind the
	// consumed count; the Adler-32 trailer identifies it exactly.
	base := pos + 2 + ctr.read + 4
	for k := 0; k <= 16; k++ {
		end := base - k
		if end < pos+6 || end > len(data) {
			continue
		}
		if got, ok := trailerChecksum(data[:end]); ok && got == want {
			return out, end, nil
		}
	}
	return nil, 0, errors.New("zlib stream end not found (adler mismatch)")
}

// resolvePackEntries turns parsed entries into final objects, applying
// deltas iteratively (a delta's base may itself be a delta).
func resolvePackEntries(entries []*rawPackEntry) ([]*store.Object, error) {
	byOffset := make(map[int]*store.Object, len(entries))
	bySHA := make(map[string]*store.Object, len(entries))
	out := make([]*store.Object, len(entries))
	pending := make([]int, 0, len(entries))
	for i, e := range entries {
		if e.typ == packOfsDelta || e.typ == packRefDelta {
			pending = append(pending, i)
			continue
		}
		obj := &store.Object{Type: typeName(e.typ), Data: e.data}
		byOffset[e.offset] = obj
		bySHA[e.sha] = obj
		out[i] = obj
	}
	for len(pending) > 0 {
		progress := false
		rest := pending[:0]
		for _, i := range pending {
			e := entries[i]
			var base *store.Object
			if e.typ == packOfsDelta {
				base = byOffset[e.baseOffset]
			} else {
				base = bySHA[e.baseSHA]
			}
			if base == nil {
				rest = append(rest, i)
				continue
			}
			data, err := applyDelta(base.Data, e.delta)
			if err != nil {
				return nil, fmt.Errorf("delta at %d: %w", e.offset, err)
			}
			obj := &store.Object{Type: base.Type, Data: data}
			sha := hashBytes(base.Type, data)
			byOffset[e.offset] = obj
			bySHA[sha] = obj
			out[i] = obj
			progress = true
		}
		pending = rest
		if !progress {
			return nil, errors.New("unresolvable delta (missing base)")
		}
	}
	return out, nil
}

// applyDelta applies git delta instructions to base and returns the
// result. The output buffer is allocated once at the declared target
// size; copy and insert operations write straight into it.
func applyDelta(base, delta []byte) ([]byte, error) {
	pos := 0
	readVarint := func() (int64, error) {
		var v int64
		var shift uint
		for {
			if pos >= len(delta) {
				return 0, errors.New("truncated delta varint")
			}
			b := delta[pos]
			pos++
			v |= int64(b&0x7f) << shift
			shift += 7
			if b&0x80 == 0 {
				return v, nil
			}
			if shift > 63 {
				return 0, errors.New("delta varint too long")
			}
		}
	}
	srcSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	if srcSize != int64(len(base)) {
		return nil, fmt.Errorf("delta base size %d, want %d", srcSize, len(base))
	}
	tgtSize, err := readVarint()
	if err != nil {
		return nil, err
	}
	if tgtSize < 0 || tgtSize > 1<<28 {
		return nil, fmt.Errorf("implausible delta target size %d", tgtSize)
	}
	out := make([]byte, tgtSize)
	w := int64(0)
	for pos < len(delta) {
		op := delta[pos]
		pos++
		if op&0x80 != 0 {
			// Copy from base: flag bits pick offset/size bytes.
			var off, size int64
			for bit := uint(0); bit < 4; bit++ {
				if op&(1<<bit) != 0 {
					if pos >= len(delta) {
						return nil, errors.New("truncated delta copy")
					}
					off |= int64(delta[pos]) << (8 * bit)
					pos++
				}
			}
			for bit := uint(0); bit < 3; bit++ {
				if op&(0x10<<bit) != 0 {
					if pos >= len(delta) {
						return nil, errors.New("truncated delta copy")
					}
					size |= int64(delta[pos]) << (8 * bit)
					pos++
				}
			}
			if size == 0 {
				size = 0x10000
			}
			if off < 0 || size < 0 || off+size > int64(len(base)) || w+size > tgtSize {
				return nil, errors.New("delta copy out of range")
			}
			copy(out[w:w+size], base[off:off+size])
			w += size
		} else if op != 0 {
			// Insert literal bytes.
			n := int(op)
			if pos+n > len(delta) || w+int64(n) > tgtSize {
				return nil, errors.New("delta insert out of range")
			}
			copy(out[w:w+int64(n)], delta[pos:pos+n])
			pos += n
			w += int64(n)
		} else {
			return nil, errors.New("delta opcode 0")
		}
	}
	if w != tgtSize {
		return nil, fmt.Errorf("delta produced %d bytes, want %d", w, tgtSize)
	}
	return out, nil
}

// ---- reachability ----

// walkResult is the outcome of one reachability walk.
type walkResult struct {
	objs    map[string]bool // object ids reached, in first-seen order via order
	order   []string        // object ids in discovery order
	shallow []string        // commits at the depth limit (deepen > 0)
}

// collectReachable walks from seeds and returns every object reachable
// from them: commits (parents followed up to deepen levels when deepen >
// 0, unlimited when 0), their trees recursively, and blobs. Commits in
// exclude are not entered and their ancestors are not followed, EXCEPT
// the seeds themselves and commits in expandThrough: a seed is always
// entered even if excluded, so the walk can expand past it (a deepen
// fetch wants a tip the client already holds; the caller filters
// excluded objects out of the result afterwards). boundary and
// expandThrough both name the client's shallow commits, but with
// opposite effects, used by different walks: in the have-walk, boundary
// commits are entered (commit plus tree/blobs) but their parents are NOT
// followed, because the client holds nothing beyond them; in the
// want-walk, expandThrough commits are entered AND expanded through
// despite being excluded, because the fetch must deliver the ancestors
// past them. Tag seeds are followed to their target.
func collectReachable(repo *store.Repo, seeds []string, deepen int, exclude map[string]bool, boundary map[string]bool, expandThrough map[string]bool) *walkResult {
	res := &walkResult{objs: make(map[string]bool)}
	add := func(sha string) bool {
		if sha == "" || sha == zeroOID || res.objs[sha] {
			return false
		}
		if repo.GetObject(sha) == nil {
			return false
		}
		res.objs[sha] = true
		res.order = append(res.order, sha)
		return true
	}
	// addTree walks a tree object and everything under it.
	var addTree func(sha string)
	addTree = func(sha string) {
		if !add(sha) {
			return
		}
		obj := repo.GetObject(sha)
		if obj == nil || obj.Type != "tree" {
			return
		}
		for _, e := range ParseTree(obj.Data) {
			if e.Mode == "40000" {
				addTree(e.SHA)
			} else {
				add(e.SHA)
			}
		}
	}
	type item struct {
		sha   string
		depth int
		seed  bool // entry point: entered even if in exclude
	}
	seenCommit := make(map[string]bool)
	queue := make([]item, 0, len(seeds))
	for _, s := range seeds {
		if s == "" || s == zeroOID {
			continue
		}
		obj := repo.GetObject(s)
		if obj == nil {
			continue
		}
		switch obj.Type {
		case "tag":
			if add(s) {
				if tgt := parseTagTarget(obj.Data); tgt != "" {
					queue = append(queue, item{sha: tgt, depth: 1, seed: true})
				}
			}
		case "commit":
			queue = append(queue, item{sha: s, depth: 1, seed: true})
		case "tree":
			addTree(s)
		default:
			add(s)
		}
	}
	for head := 0; head < len(queue); head++ {
		cur := queue[head]
		if seenCommit[cur.sha] || (exclude[cur.sha] && !cur.seed && !expandThrough[cur.sha]) {
			continue
		}
		seenCommit[cur.sha] = true
		obj := repo.GetObject(cur.sha)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		add(cur.sha)
		tree, parents := ParseCommit(obj.Data)
		addTree(tree)
		if deepen > 0 && cur.depth >= deepen {
			res.shallow = append(res.shallow, cur.sha)
			continue
		}
		if boundary[cur.sha] {
			// Shallow boundary: the client holds this commit and its
			// tree/blobs, but none of its ancestors. Do not expand.
			continue
		}
		for _, p := range parents {
			if !seenCommit[p] {
				queue = append(queue, item{sha: p, depth: cur.depth + 1})
			}
		}
	}
	return res
}

// Reachable returns the objects a fetch for wants must send: everything
// reachable from wants (honouring deepen) minus everything the client
// actually holds, plus the shallow-boundary commits. unshallow is always
// nil here: which previously-shallow commits become unshallow depends on
// the client's own shallow list, which the fetch handler computes itself.
//
// clientShallow is the client's shallow list. It bounds the have-walk:
// a shallow clone holds a boundary commit and its tree/blobs but none of
// its ancestors, so the have-walk must not expand past those commits.
// Without this, a deepen fetch from a shallow clone would wrongly treat
// the unseen ancestors as already held and send nothing. The want-walk
// instead expands THROUGH the same boundary commits (they are excluded
// from what is sent, since the client holds them, but their ancestors
// are exactly what the deepen fetch must deliver): the fetch is how the
// client deepens past its old boundary.
func Reachable(repo *store.Repo, wants []string, haves map[string]bool, deepen int, clientShallow []string) (objs []*store.Object, shallow []string, unshallow []string) {
	haveSeeds := make([]string, 0, len(haves))
	for h := range haves {
		haveSeeds = append(haveSeeds, h)
	}
	boundary := make(map[string]bool, len(clientShallow))
	for _, s := range clientShallow {
		boundary[s] = true
	}
	haveWalk := collectReachable(repo, haveSeeds, 0, nil, boundary, nil)
	haveSet := make(map[string]bool, len(haveWalk.objs))
	for sha := range haveWalk.objs {
		haveSet[sha] = true
	}
	wantWalk := collectReachable(repo, wants, deepen, haveSet, nil, boundary)
	for _, sha := range wantWalk.order {
		if haveSet[sha] {
			continue
		}
		if obj := repo.GetObject(sha); obj != nil {
			objs = append(objs, obj)
		}
	}
	for _, s := range wantWalk.shallow {
		if !haveSet[s] {
			shallow = append(shallow, s)
		}
	}
	return objs, shallow, nil
}

// IsAncestor reports whether ancestor is reachable from descendant by
// following parent links (including ancestor == descendant).
func IsAncestor(repo *store.Repo, ancestor, descendant string) bool {
	if ancestor == "" || descendant == "" {
		return false
	}
	if ancestor == descendant {
		return true
	}
	seen := make(map[string]bool)
	stack := []string{descendant}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		obj := repo.GetObject(cur)
		if obj == nil || obj.Type != "commit" {
			continue
		}
		_, parents := ParseCommit(obj.Data)
		for _, p := range parents {
			if p == ancestor {
				return true
			}
			stack = append(stack, p)
		}
	}
	return false
}

// countLines counts the lines in blob data: newlines, plus a final
// unterminated line. Empty data has zero lines; any non-empty blob has
// at least one.
func countLines(data []byte) int {
	if len(data) == 0 {
		return 0
	}
	n := bytes.Count(data, []byte{'\n'})
	if data[len(data)-1] != '\n' {
		n++
	}
	return n
}

// DiffTrees compares two trees recursively and returns the changed files:
// added files (new blob), modified files (blob sha changed), and deleted
// files. Status is "added", "modified", or "changed" (deleted files are
// reported as "changed"); additions/deletions are line counts, with a
// non-empty blob counting at least one line.
func DiffTrees(repo *store.Repo, baseTree, headTree string) []store.PullFile {
	var out []store.PullFile
	diffTreesInto(repo, baseTree, headTree, "", &out)
	return out
}

func diffTreesInto(repo *store.Repo, baseTree, headTree, prefix string, out *[]store.PullFile) {
	base := getTree(repo, baseTree)
	head := getTree(repo, headTree)
	byName := func(entries []TreeEntry) map[string]TreeEntry {
		m := make(map[string]TreeEntry, len(entries))
		for _, e := range entries {
			m[e.Name] = e
		}
		return m
	}
	bm, hm := byName(base), byName(head)
	blobLines := func(sha string) int {
		obj := repo.GetObject(sha)
		if obj == nil {
			return 0
		}
		return countLines(obj.Data)
	}
	for _, e := range head {
		full := prefix + e.Name
		b, ok := bm[e.Name]
		if !ok {
			if e.Mode == "40000" {
				diffTreesInto(repo, "", e.SHA, full+"/", out)
			} else {
				n := blobLines(e.SHA)
				*out = append(*out, store.PullFile{Filename: full, Status: "added", Additions: n, Deletions: 0, Changes: n})
			}
			continue
		}
		if e.Mode == "40000" && b.Mode == "40000" {
			if e.SHA != b.SHA {
				diffTreesInto(repo, b.SHA, e.SHA, full+"/", out)
			}
			continue
		}
		if e.Mode != "40000" && b.Mode != "40000" {
			if e.SHA == b.SHA {
				continue
			}
			add := blobLines(e.SHA)
			del := blobLines(b.SHA)
			*out = append(*out, store.PullFile{Filename: full, Status: "modified", Additions: add, Deletions: del, Changes: add + del})
			continue
		}
		// Type changed (blob <-> tree): report as delete + add.
		if b.Mode == "40000" {
			diffTreesInto(repo, b.SHA, "", full+"/", out)
		} else {
			n := blobLines(b.SHA)
			*out = append(*out, store.PullFile{Filename: full, Status: "changed", Additions: 0, Deletions: n, Changes: n})
		}
		if e.Mode == "40000" {
			diffTreesInto(repo, "", e.SHA, full+"/", out)
		} else {
			n := blobLines(e.SHA)
			*out = append(*out, store.PullFile{Filename: full, Status: "added", Additions: n, Deletions: 0, Changes: n})
		}
	}
	for _, e := range base {
		if _, ok := hm[e.Name]; ok {
			continue
		}
		full := prefix + e.Name
		if e.Mode == "40000" {
			diffTreesInto(repo, e.SHA, "", full+"/", out)
			continue
		}
		n := blobLines(e.SHA)
		*out = append(*out, store.PullFile{Filename: full, Status: "changed", Additions: 0, Deletions: n, Changes: n})
	}
}
