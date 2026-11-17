// Unit tests for the git layer: pkt-line framing, object helpers, pack
// round-trips (including deltas), and the upload/receive-pack handlers
// exercised over httptest against the real store.
package git

import (
	"bytes"
	"compress/zlib"
	"crypto/sha1"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"forge/internal/store"
)

// ---- helpers ----

// seedCommit creates one commit on main with a single file and returns
// the commit sha.
func seedCommit(tb testing.TB, repo *store.Repo, path, content string) string {
	tb.Helper()
	blob := MakeBlob(repo, []byte(content))
	tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: path, SHA: blob}})
	commit := MakeCommit(repo, tree, nil, "seed "+path)
	repo.SetRef("refs/heads/main", commit)
	return commit
}

// deflate returns the zlib stream (level 1) for data.
func deflate(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw, err := zlib.NewWriterLevel(&buf, zlib.BestSpeed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// packObjectHeader encodes a pack object header (type + size varint).
func packObjectHeader(typ int, size int) []byte {
	var out []byte
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

// ---- pkt-line ----

func TestPktLineRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := writePktLine(&buf, "hello\n"); err != nil {
		t.Fatal(err)
	}
	writeFlush(&buf)
	writeDelim(&buf)
	if err := writePktLine(&buf, "version 2\n"); err != nil {
		t.Fatal(err)
	}
	lines, err := parsePktLines(buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 4 {
		t.Fatalf("got %d lines, want 4", len(lines))
	}
	if lines[0].kind != pktData || string(lines[0].data) != "hello\n" {
		t.Fatalf("line 0 = %+v", lines[0])
	}
	if lines[1].kind != pktFlush || lines[2].kind != pktDelim {
		t.Fatalf("flush/delim kinds wrong: %+v %+v", lines[1], lines[2])
	}
	if string(lines[3].data) != "version 2\n" {
		t.Fatalf("line 3 = %q", lines[3].data)
	}
}

// ---- objects ----

func TestHashObjectEmptyBlob(t *testing.T) {
	// sha1("blob 0\0") — the well-known empty-blob id.
	if got := HashObject("blob", nil); got != "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" {
		t.Fatalf("empty blob sha = %s", got)
	}
}

func TestTreeRoundTrip(t *testing.T) {
	entries := []TreeEntry{
		{Mode: "100644", Name: "b.txt", SHA: HashObject("blob", []byte("b"))},
		{Mode: "100644", Name: "a.txt", SHA: HashObject("blob", []byte("a"))},
		{Mode: "40000", Name: "dir", SHA: HashObject("tree", nil)},
	}
	raw := BuildTree(entries)
	back := ParseTree(raw)
	if len(back) != 3 {
		t.Fatalf("parsed %d entries, want 3", len(back))
	}
	// Git order: a.txt, b.txt, dir/ (directories sort with a slash).
	if back[0].Name != "a.txt" || back[1].Name != "b.txt" || back[2].Name != "dir" {
		t.Fatalf("order wrong: %+v", back)
	}
	if back[0].SHA != entries[1].SHA {
		t.Fatalf("sha mismatch: %s vs %s", back[0].SHA, entries[1].SHA)
	}
}

func TestUpdateTreeLookupListDir(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	tree := UpdateTree(repo, "", "docs/readme.md", MakeBlob(repo, []byte("hi\n")))
	if tree == "" {
		t.Fatal("UpdateTree returned empty tree")
	}
	sha, typ, found := LookupPath(repo, tree, "docs/readme.md")
	if !found || typ != "blob" {
		t.Fatalf("lookup docs/readme.md: found=%v typ=%s", found, typ)
	}
	obj := repo.GetObject(sha)
	if obj == nil || string(obj.Data) != "hi\n" {
		t.Fatalf("blob content = %q", obj)
	}
	entries := ListDir(repo, tree, "docs")
	if len(entries) != 1 || entries[0].Name != "readme.md" {
		t.Fatalf("ListDir docs = %+v", entries)
	}
	if got := ListDir(repo, tree, "docs/readme.md"); got != nil {
		t.Fatalf("ListDir on a file should be nil, got %+v", got)
	}
	// Delete the file: the tree becomes empty.
	empty := UpdateTree(repo, tree, "docs/readme.md", "")
	if empty != "" {
		t.Fatalf("tree after delete = %q, want empty", empty)
	}
	// Replace a file in place.
	tree2 := UpdateTree(repo, tree, "docs/readme.md", MakeBlob(repo, []byte("yo\n")))
	sha2, _, found2 := LookupPath(repo, tree2, "docs/readme.md")
	if !found2 || sha2 == sha {
		t.Fatalf("update in place failed: found=%v same=%v", found2, sha2 == sha)
	}
}

func TestMakeCommitParse(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	blob := MakeBlob(repo, []byte("x"))
	tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "f", SHA: blob}})
	c1 := MakeCommit(repo, tree, nil, "first")
	c2 := MakeCommit(repo, tree, []string{c1}, "second")
	obj := repo.GetObject(c2)
	if obj == nil || obj.Type != "commit" {
		t.Fatal("commit not stored")
	}
	gotTree, parents := ParseCommit(obj.Data)
	if gotTree != tree || len(parents) != 1 || parents[0] != c1 {
		t.Fatalf("ParseCommit = tree %s parents %v", gotTree, parents)
	}
	if !IsAncestor(repo, c1, c2) || IsAncestor(repo, c2, c1) {
		t.Fatalf("IsAncestor wrong for %s -> %s", c1, c2)
	}
}

// ---- packs ----

func TestPackRoundTrip(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	objs, _, _ := Reachable(repo, []string{c1}, map[string]bool{}, 0, nil)
	pack := BuildPack(objs)
	back, err := ParsePack(pack)
	if err != nil {
		t.Fatal(err)
	}
	if len(back) != len(objs) {
		t.Fatalf("parsed %d objects, want %d", len(back), len(objs))
	}
	want := make(map[string]string)
	for _, o := range objs {
		want[HashObject(o.Type, o.Data)] = o.Type
	}
	for _, o := range back {
		sha := HashObject(o.Type, o.Data)
		if typ, ok := want[sha]; !ok || typ != o.Type {
			t.Fatalf("unexpected object %s %s", sha, o.Type)
		}
	}
	// A corrupt trailer must fail.
	bad := append([]byte(nil), pack...)
	bad[len(bad)-1] ^= 0xff
	if _, err := ParsePack(bad); err == nil {
		t.Fatal("corrupt trailer parsed without error")
	}
	// A truncated pack must fail.
	if _, err := ParsePack(pack[:len(pack)/2]); err == nil {
		t.Fatal("truncated pack parsed without error")
	}
}

// TestPackRefDelta builds a pack by hand with one ref-delta object and
// checks ParsePack resolves it to the same bytes as the full object.
func TestPackRefDelta(t *testing.T) {
	base := []byte("hello world, hello world\n")
	target := []byte("hello world, hello brave new world\n")
	baseSHA := HashObject("blob", base)
	// Delta: source size, target size, copy 0..12, insert rest.
	var delta bytes.Buffer
	delta.WriteByte(byte(len(base)))   // source size varint (single byte)
	delta.WriteByte(byte(len(target))) // target size varint
	delta.WriteByte(0x80 | 0x10)       // copy, 1 size byte, offset 0
	delta.WriteByte(12)                // copy 12 bytes from offset 0
	rest := target[12:]
	delta.WriteByte(byte(len(rest))) // insert
	delta.Write(rest)
	// Pack: 2 objects, base blob then ref-delta.
	var pack bytes.Buffer
	pack.WriteString("PACK")
	var hdr [8]byte
	hdr[0], hdr[1], hdr[2], hdr[3] = 0, 0, 0, 2
	hdr[4], hdr[5], hdr[6], hdr[7] = 0, 0, 0, 2
	pack.Write(hdr[:])
	pack.Write(packObjectHeader(packBlob, len(base)))
	pack.Write(deflate(t, base))
	pack.Write(packObjectHeader(packRefDelta, len(delta.Bytes())))
	pack.Write(hexDecode(t, baseSHA))
	pack.Write(deflate(t, delta.Bytes()))
	sum := sha1.Sum(pack.Bytes())
	pack.Write(sum[:])
	objs, err := ParsePack(pack.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 2 {
		t.Fatalf("got %d objects, want 2", len(objs))
	}
	if objs[1].Type != "blob" || !bytes.Equal(objs[1].Data, target) {
		t.Fatalf("delta resolved to %q, want %q", objs[1].Data, target)
	}
}

// encodeOfsOffset encodes a delta base offset the way git does: 7-bit
// big-endian groups, all but the last with the high bit set, with the
// -1 adjustment the decoder applies at each step.
func encodeOfsOffset(off int64) []byte {
	stack := []byte{byte(off & 0x7f)}
	off >>= 7
	for off > 0 {
		off--
		stack = append([]byte{byte(0x80 | (off & 0x7f))}, stack...)
		off >>= 7
	}
	return stack
}

// TestPackOfsDelta builds a pack by hand with one ofs-delta object.
func TestPackOfsDelta(t *testing.T) {
	base := []byte("alpha beta gamma delta\n")
	target := []byte("alpha beta gamma DELTA epsilon\n")
	var delta bytes.Buffer
	delta.WriteByte(byte(len(base)))
	delta.WriteByte(byte(len(target)))
	delta.WriteByte(0x80 | 0x10) // copy, 1 size byte, offset 0
	delta.WriteByte(17)          // copy "alpha beta gamma "
	rest := target[17:]
	delta.WriteByte(byte(len(rest)))
	delta.Write(rest)
	var pack bytes.Buffer
	pack.WriteString("PACK")
	var hdr [8]byte
	hdr[3] = 2
	hdr[7] = 2
	pack.Write(hdr[:])
	pack.Write(packObjectHeader(packBlob, len(base)))
	pack.Write(deflate(t, base))
	deltaStart := pack.Len()
	pack.Write(packObjectHeader(packOfsDelta, len(delta.Bytes())))
	pack.Write(encodeOfsOffset(int64(deltaStart - 12)))
	pack.Write(deflate(t, delta.Bytes()))
	sum := sha1.Sum(pack.Bytes())
	pack.Write(sum[:])
	objs, err := ParsePack(pack.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if len(objs) != 2 {
		t.Fatalf("got %d objects, want 2", len(objs))
	}
	if objs[1].Type != "blob" || !bytes.Equal(objs[1].Data, target) {
		t.Fatalf("ofs-delta resolved to %q, want %q", objs[1].Data, target)
	}
}

func hexDecode(t *testing.T, s string) []byte {
	t.Helper()
	out := make([]byte, len(s)/2)
	for i := range out {
		hi := hexVal(s[2*i])
		lo := hexVal(s[2*i+1])
		out[i] = byte(hi<<4 | lo)
	}
	return out
}

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	default:
		return 0
	}
}

// TestReachableDepth1 checks that a depth-1 walk sends only the tip
// commit plus its tree and blobs.
func TestReachableDepth1(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	blob2 := MakeBlob(repo, []byte("two\n"))
	tree2 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob2}})
	c2 := MakeCommit(repo, tree2, []string{c1}, "second")
	repo.SetRef("refs/heads/main", c2)
	objs, shallow, _ := Reachable(repo, []string{c2}, map[string]bool{}, 1, nil)
	bySHA := make(map[string]bool)
	for _, o := range objs {
		bySHA[HashObject(o.Type, o.Data)] = true
	}
	if !bySHA[c2] || bySHA[c1] {
		t.Fatalf("depth-1 reachable wrong: has tip=%v has parent=%v", bySHA[c2], bySHA[c1])
	}
	if len(shallow) != 1 || shallow[0] != c2 {
		t.Fatalf("shallow = %v, want [%s]", shallow, c2)
	}
	// With the parent as a have, a full fetch sends only the new tip.
	objs2, _, _ := Reachable(repo, []string{c2}, map[string]bool{c1: true}, 0, nil)
	bySHA2 := make(map[string]bool)
	for _, o := range objs2 {
		bySHA2[HashObject(o.Type, o.Data)] = true
	}
	if !bySHA2[c2] || bySHA2[c1] {
		t.Fatalf("have-filtered reachable wrong: %v", bySHA2)
	}
}

// TestReachableDeepen2ShallowHave is the regression test for the
// fetch-shallow-deepen failure (manual-env run 17 Nov, 118/120): a client
// with a depth-1 shallow clone holds tip c2 (have + shallow = c2) but NOT
// its parent c1. A deepen-2 fetch of c2 must therefore send c1, with c1
// as the new shallow boundary. Before the fix the have-walk expanded
// past the shallow boundary, treated c1 as already held, and sent
// nothing. A deeper variant is covered too: with a depth-2 shallow clone
// (have c3, shallow c2) a deepen-3 fetch must send the grandparent.
func TestReachableDeepen2ShallowHave(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	blob2 := MakeBlob(repo, []byte("two\n"))
	tree2 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob2}})
	c2 := MakeCommit(repo, tree2, []string{c1}, "second")
	repo.SetRef("refs/heads/main", c2)

	objs, shallow, _ := Reachable(repo, []string{c2}, map[string]bool{c2: true}, 2, []string{c2})
	bySHA := make(map[string]bool)
	for _, o := range objs {
		bySHA[HashObject(o.Type, o.Data)] = true
	}
	if !bySHA[c1] {
		t.Fatalf("deepen-2 with shallow have did not send parent: %v", bySHA)
	}
	if bySHA[c2] {
		t.Fatalf("deepen-2 re-sent the tip the client already holds: %v", bySHA)
	}
	if len(shallow) != 1 || shallow[0] != c1 {
		t.Fatalf("shallow = %v, want [%s]", shallow, c1)
	}

	// Depth-2 shallow clone deepening to 3: boundary c2 must stop the
	// have-walk, so the grandparent c1 is sent. The walk to c1 goes
	// THROUGH c2, which the client already holds, so c2 itself is not
	// re-sent — only c1 (plus its tree/blob) is.
	blob3 := MakeBlob(repo, []byte("three\n"))
	tree3 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob3}})
	c3 := MakeCommit(repo, tree3, []string{c2}, "third")
	repo.SetRef("refs/heads/main", c3)
	objs3, shallow3, _ := Reachable(repo, []string{c3}, map[string]bool{c3: true}, 3, []string{c2})
	bySHA3 := make(map[string]bool)
	for _, o := range objs3 {
		bySHA3[HashObject(o.Type, o.Data)] = true
	}
	if !bySHA3[c1] {
		t.Fatalf("deepen-3 with shallow boundary did not send grandparent: %v", bySHA3)
	}
	if bySHA3[c2] || bySHA3[c3] {
		t.Fatalf("deepen-3 re-sent commits the client already holds: %v", bySHA3)
	}
	if len(shallow3) != 1 || shallow3[0] != c1 {
		t.Fatalf("shallow = %v, want [%s]", shallow3, c1)
	}
}

// ---- handlers ----

// v2Request builds a protocol v2 request body from command + args.
func v2Request(command string, args ...string) []byte {
	var buf bytes.Buffer
	_ = writePktLine(&buf, "command="+command+"\n")
	_ = writePktLine(&buf, "object-format=sha1\n")
	writeDelim(&buf)
	for _, a := range args {
		_ = writePktLine(&buf, a+"\n")
	}
	writeFlush(&buf)
	return buf.Bytes()
}

func TestInfoRefsV2AndV0(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	seedCommit(t, repo, "a.txt", "one\n")
	h := Handler(s)

	// v2 advertisement.
	req := httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	req.Header.Set("Git-Protocol", "version=2")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("info/refs v2 status = %d", rec.Code)
	}
	lines, err := parsePktLines(rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	texts := pktLineStrings(lines)
	joined := strings.Join(texts, "")
	if !strings.Contains(joined, "version 2\n") || !strings.Contains(joined, "ls-refs\n") {
		t.Fatalf("v2 advertisement missing version/caps: %q", joined)
	}

	// v0 advertisement.
	req = httptest.NewRequest(http.MethodGet, "/alice/demo.git/info/refs?service=git-upload-pack", nil)
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("info/refs v0 status = %d", rec.Code)
	}
	lines, err = parsePktLines(rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	texts = pktLineStrings(lines)
	joined = strings.Join(texts, "")
	if !strings.Contains(joined, "side-band-64k") {
		t.Fatalf("v0 advertisement missing side-band-64k: %q", joined)
	}
	if !strings.Contains(joined, "refs/heads/main") {
		t.Fatalf("v0 advertisement missing main: %q", joined)
	}

	// Missing repo is 404 and the server survives.
	req = httptest.NewRequest(http.MethodGet, "/alice/nope.git/info/refs?service=git-upload-pack", nil)
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing repo status = %d, want 404", rec.Code)
	}
}

// TestLsRefsFetchRoundTrip also covers an annotated tag: the tag line
// must carry the peeled:<commit> attribute and a "^{}" line.
func TestLsRefsTagPeel(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	tip := seedCommit(t, repo, "a.txt", "one\n")
	tagObj := repo.PutObject("tag", []byte("object "+tip+"\ntype commit\ntag v1\ntagger Heryp0401 <herrylf33@gmail.com> 1767225600 +0000\n\nrelease v1\n"))
	repo.SetRef("refs/tags/v1", tagObj)
	h := Handler(s)
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(v2Request("ls-refs", "peel", "symrefs", "unborn")))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ls-refs status = %d", rec.Code)
	}
	joined := strings.Join(pktLineStrings(mustParsePktLines(t, rec.Body.Bytes())), "")
	if !strings.Contains(joined, tagObj+" refs/tags/v1 peeled:"+tip) {
		t.Fatalf("ls-refs missing peeled attribute: %q", joined)
	}
	if !strings.Contains(joined, tip+" refs/tags/v1^{}\n") {
		t.Fatalf("ls-refs missing ^{} line: %q", joined)
	}
}

// TestFetchWithHaves checks the acknowledgments section the brief
// requires: ACK per have held plus "ready", and NAK when no haves.
func TestFetchWithHaves(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	blob2 := MakeBlob(repo, []byte("two\n"))
	tree2 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob2}})
	c2 := MakeCommit(repo, tree2, []string{c1}, "second")
	repo.SetRef("refs/heads/main", c2)
	h := Handler(s)
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack",
		bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+c2, "have "+c1, "done")))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch status = %d", rec.Code)
	}
	joined := strings.Join(pktLineStrings(mustParsePktLines(t, rec.Body.Bytes())), "")
	if !strings.Contains(joined, "acknowledgments\n") || !strings.Contains(joined, "ACK "+c1+"\n") || !strings.Contains(joined, "ready\n") {
		t.Fatalf("fetch acks wrong: %q", joined)
	}
	pack, err := extractSidebandPack(t, rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	objs, err := ParsePack(pack)
	if err != nil {
		t.Fatal(err)
	}
	found := make(map[string]bool)
	for _, o := range objs {
		found[HashObject(o.Type, o.Data)] = true
	}
	if !found[c2] || found[c1] {
		t.Fatalf("have-filtered pack wrong: has tip=%v has parent=%v", found[c2], found[c1])
	}
}

// TestFetchDeepen2WithShallow checks the deepen-2 walk: the parent of a
// shallow tip is sent, becomes the new shallow boundary, and the old
// shallow tip is reported unshallow.
func TestFetchDeepen2WithShallow(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	blob2 := MakeBlob(repo, []byte("two\n"))
	tree2 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob2}})
	c2 := MakeCommit(repo, tree2, []string{c1}, "second")
	repo.SetRef("refs/heads/main", c2)
	h := Handler(s)
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack",
		// Real git sends "have <tip>" for a shallow clone's tip; without
		// it this test passed even while the deepen fetch sent no parent.
		bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+c2, "have "+c2, "shallow "+c2, "deepen 2", "done")))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch status = %d", rec.Code)
	}
	joined := strings.Join(pktLineStrings(mustParsePktLines(t, rec.Body.Bytes())), "")
	if !strings.Contains(joined, "shallow-info\n") {
		t.Fatalf("missing shallow-info section: %q", joined)
	}
	if !strings.Contains(joined, "shallow "+c1+"\n") {
		t.Fatalf("new shallow should be the parent: %q", joined)
	}
	if !strings.Contains(joined, "unshallow "+c2+"\n") {
		t.Fatalf("old shallow tip should be unshallow: %q", joined)
	}
	// The shallow-info section must be flush-terminated before packfile.
	lines := mustParsePktLines(t, rec.Body.Bytes())
	sawFlush := false
	for i, l := range lines {
		if l.kind == pktData && string(l.data) == "packfile\n" {
			if i == 0 || lines[i-1].kind != pktFlush {
				t.Fatal("packfile section is not preceded by a flush")
			}
			sawFlush = true
		}
	}
	if !sawFlush {
		t.Fatal("no packfile section found")
	}
}

// TestUnbornRepoLsRefs checks an empty repository reports HEAD unborn.
func TestUnbornRepoLsRefs(t *testing.T) {
	s, _ := testStoreWithRepo(t)
	h := Handler(s)
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(v2Request("ls-refs", "peel", "symrefs", "unborn")))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ls-refs status = %d", rec.Code)
	}
	joined := strings.Join(pktLineStrings(mustParsePktLines(t, rec.Body.Bytes())), "")
	if !strings.Contains(joined, "unborn HEAD symref-target:refs/heads/main") {
		t.Fatalf("unborn ls-refs wrong: %q", joined)
	}
}

// TestConcurrentDepth1Fetches mirrors the clone workload: 50 concurrent
// depth-1 fetches of a 200-commit repo must all return the tip pack.
func TestConcurrentDepth1Fetches(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	var parent string
	var tip string
	for i := 1; i <= 200; i++ {
		blob := MakeBlob(repo, []byte("content "+string(rune('a'+i%26))+" "+strings.Repeat("x", i%50)+"\n"))
		tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "f.txt", SHA: blob}})
		var parents []string
		if parent != "" {
			parents = []string{parent}
		}
		tip = MakeCommit(repo, tree, parents, "commit")
		parent = tip
	}
	repo.SetRef("refs/heads/main", tip)
	h := Handler(s)
	errs := make(chan error, 50)
	for n := 0; n < 50; n++ {
		go func() {
			req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack",
				bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+tip, "deepen 1", "done")))
			rec := httptest.NewRecorder()
			h(rec, req)
			if rec.Code != http.StatusOK {
				errs <- errFetchStatus
				return
			}
			pack, err := extractSidebandPack(t, rec.Body.Bytes())
			if err != nil {
				errs <- err
				return
			}
			objs, err := ParsePack(pack)
			if err != nil {
				errs <- err
				return
			}
			for _, o := range objs {
				if HashObject(o.Type, o.Data) == tip {
					errs <- nil
					return
				}
			}
			errs <- errNoTip
		}()
	}
	for n := 0; n < 50; n++ {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
	}
}

var errFetchStatus = &testError{"fetch status != 200"}
var errNoTip = &testError{"tip commit missing from fetched pack"}

func mustParsePktLines(t *testing.T, b []byte) []pktLine {
	t.Helper()
	lines, err := parsePktLines(b)
	if err != nil {
		t.Fatal(err)
	}
	return lines
}

func TestLsRefsFetchRoundTrip(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	tip := seedCommit(t, repo, "a.txt", "one\n")
	h := Handler(s)

	// ls-refs.
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(v2Request("ls-refs", "peel", "symrefs", "unborn")))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("ls-refs status = %d", rec.Code)
	}
	lines, err := parsePktLines(rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(pktLineStrings(lines), "")
	if !strings.Contains(joined, tip+" HEAD symref-target:refs/heads/main") {
		t.Fatalf("ls-refs missing HEAD symref: %q", joined)
	}
	if !strings.Contains(joined, tip+" refs/heads/main") {
		t.Fatalf("ls-refs missing main: %q", joined)
	}

	// fetch depth 1: parse the response sections and the sideband pack.
	req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack",
		bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+tip, "deepen 1", "done")))
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("fetch status = %d", rec.Code)
	}
	pack, err := extractSidebandPack(t, rec.Body.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	objs, err := ParsePack(pack)
	if err != nil {
		t.Fatal(err)
	}
	found := make(map[string]bool)
	for _, o := range objs {
		found[HashObject(o.Type, o.Data)] = true
	}
	if !found[tip] {
		t.Fatalf("fetch pack missing tip %s (got %d objects)", tip, len(objs))
	}
	if !strings.Contains(rec.Body.String(), "shallow "+tip) {
		t.Fatalf("fetch response missing shallow-info for tip")
	}
	// A second identical fetch must hit the head-pack cache and agree.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack",
		bytes.NewReader(v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+tip, "deepen 1", "done")))
	h(rec2, req2)
	if !bytes.Equal(rec.Body.Bytes(), rec2.Body.Bytes()) {
		t.Fatal("cached fetch differs from the first fetch")
	}
}

// extractSidebandPack parses an upload-pack response body, checks the
// section framing (acknowledgments, shallow-info + flush, packfile), and
// returns the reassembled pack bytes from sideband band 1.
func extractSidebandPack(t *testing.T, body []byte) ([]byte, error) {
	t.Helper()
	lines, err := parsePktLines(body)
	if err != nil {
		return nil, err
	}
	var pack []byte
	inPack := false
	sawShallowFlush := false
	for i, l := range lines {
		if l.kind != pktData {
			if inPack && l.kind == pktFlush {
				break
			}
			if l.kind == pktFlush {
				sawShallowFlush = true
			}
			continue
		}
		text := string(l.data)
		if text == "packfile\n" {
			inPack = true
			continue
		}
		if !inPack {
			continue
		}
		// Sideband pkt-lines arrive as nested pkt-lines inside the
		// packfile section: each data line is itself framed.
		_ = i
		_ = sawShallowFlush
		if len(l.data) < 1 || l.data[0] != 1 {
			return nil, errUnexpectedBand
		}
		pack = append(pack, l.data[1:]...)
	}
	if len(pack) == 0 {
		return nil, errNoPack
	}
	return pack, nil
}

var errUnexpectedBand = &testError{"unexpected sideband band"}
var errNoPack = &testError{"no pack bytes in response"}

type testError struct{ msg string }

func (e *testError) Error() string { return e.msg }

// TestReceivePackPushAndNonFF pushes a new commit, then a non-fast-
// forward push, and checks the report lines and ref state.
func TestReceivePackPushAndNonFF(t *testing.T) {
	s, repo := testStoreWithRepo(t)
	c1 := seedCommit(t, repo, "a.txt", "one\n")
	h := Handler(s)

	// Build c2 locally in a scratch repo object set, then push it.
	blob2 := MakeBlob(repo, []byte("two\n"))
	tree2 := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "a.txt", SHA: blob2}})
	c2 := MakeCommit(repo, tree2, []string{c1}, "second")
	// The objects already exist in the store (created above); a real
	// client would send them in the pack. Send a pack with them anyway.
	packObjs := []*store.Object{
		repo.GetObject(c2),
		repo.GetObject(tree2),
		repo.GetObject(blob2),
	}
	pack := BuildPack(packObjs)
	var body bytes.Buffer
	_ = writePktLine(&body, c1+" "+c2+" refs/heads/main\n")
	writeFlush(&body)
	body.Write(pack)
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewReader(body.Bytes()))
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("receive-pack status = %d", rec.Code)
	}
	report := rec.Body.String()
	if !strings.Contains(report, "unpack ok") || !strings.Contains(report, "ok refs/heads/main") {
		t.Fatalf("push report wrong: %q", report)
	}
	if got := repo.Ref("refs/heads/main"); got != c2 {
		t.Fatalf("ref after push = %s, want %s", got, c2)
	}

	// Non-fast-forward: try to move main back to c1.
	var body2 bytes.Buffer
	_ = writePktLine(&body2, c2+" "+c1+" refs/heads/main\n")
	writeFlush(&body2)
	body2.Write(BuildPack(nil))
	req = httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewReader(body2.Bytes()))
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("non-FF push status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "ng refs/heads/main non-fast-forward") {
		t.Fatalf("non-FF report wrong: %q", rec.Body.String())
	}
	if got := repo.Ref("refs/heads/main"); got != c2 {
		t.Fatalf("ref moved on refused push: %s", got)
	}
}

// ---- benchmarks: push/clone workload timing ----

// BenchmarkFetchDepth1 measures one depth-1 fetch of a 200-commit repo
// through the handler, with the head-pack cache warm (the clone workload
// shape: 50 concurrent clones hit the same tip).
func BenchmarkFetchDepth1(b *testing.B) {
	s, repo := testStoreWithRepo(b)
	var parent string
	var tip string
	for i := 1; i <= 200; i++ {
		blob := MakeBlob(repo, []byte("content "+strings.Repeat("x", 100)+"\n"))
		tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "f.txt", SHA: blob}})
		var parents []string
		if parent != "" {
			parents = []string{parent}
		}
		tip = MakeCommit(repo, tree, parents, "commit")
		parent = tip
	}
	repo.SetRef("refs/heads/main", tip)
	h := Handler(s)
	body := v2Request("fetch", "thin-pack", "no-progress", "ofs-delta", "want "+tip, "deepen 1", "done")
	// Warm the head-pack cache once.
	req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(body))
	h(httptest.NewRecorder(), req)
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-upload-pack", bytes.NewReader(body))
			rec := httptest.NewRecorder()
			h(rec, req)
			if rec.Code != http.StatusOK {
				b.Fatalf("fetch status = %d", rec.Code)
			}
		}
	})
}

// BenchmarkPush measures one sequential 1 KiB push through receive-pack:
// build the commit, pack it, POST it, advance the ref.
func BenchmarkPush(b *testing.B) {
	s, repo := testStoreWithRepo(b)
	tip := seedCommit(b, repo, "f.txt", strings.Repeat("x", 1024)+"\n")
	h := Handler(s)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		blob := MakeBlob(repo, []byte(strings.Repeat("y", 1024)+"\n"))
		tree := MakeTree(repo, []TreeEntry{{Mode: "100644", Name: "f.txt", SHA: blob}})
		next := MakeCommit(repo, tree, []string{tip}, "push")
		pack := BuildPack([]*store.Object{repo.GetObject(next), repo.GetObject(tree), repo.GetObject(blob)})
		var body bytes.Buffer
		_ = writePktLine(&body, tip+" "+next+" refs/heads/main\n")
		writeFlush(&body)
		body.Write(pack)
		req := httptest.NewRequest(http.MethodPost, "/alice/demo.git/git-receive-pack", bytes.NewReader(body.Bytes()))
		rec := httptest.NewRecorder()
		h(rec, req)
		if rec.Code != http.StatusOK {
			b.Fatalf("push status = %d", rec.Code)
		}
		tip = next
	}
}

func testStoreWithRepo(tb testing.TB) (*store.Store, *store.Repo) {
	tb.Helper()
	s := store.NewStore("test-token")
	repo := s.CreateRepo("alice", "demo", true, "demo repo")
	if repo == nil {
		tb.Fatal("CreateRepo returned nil")
	}
	return s, repo
}

// TestDiffTrees checks added/modified/deleted reporting.
func TestDiffTrees(t *testing.T) {
	_, repo := testStoreWithRepo(t)
	base := MakeTree(repo, []TreeEntry{
		{Mode: "100644", Name: "keep.txt", SHA: MakeBlob(repo, []byte("a\nb\n"))},
		{Mode: "100644", Name: "gone.txt", SHA: MakeBlob(repo, []byte("x\n"))},
	})
	head := MakeTree(repo, []TreeEntry{
		{Mode: "100644", Name: "keep.txt", SHA: MakeBlob(repo, []byte("a\nb\nc\n"))},
		{Mode: "100644", Name: "new.txt", SHA: MakeBlob(repo, []byte("n\n"))},
	})
	files := DiffTrees(repo, base, head)
	byName := make(map[string]store.PullFile)
	for _, f := range files {
		byName[f.Filename] = f
	}
	if len(files) != 3 {
		t.Fatalf("diff gave %d files, want 3: %+v", len(files), files)
	}
	if byName["new.txt"].Status != "added" || byName["new.txt"].Additions != 1 {
		t.Fatalf("new.txt = %+v", byName["new.txt"])
	}
	if byName["keep.txt"].Status != "modified" || byName["keep.txt"].Additions != 3 || byName["keep.txt"].Deletions != 2 {
		t.Fatalf("keep.txt = %+v", byName["keep.txt"])
	}
	if byName["gone.txt"].Deletions != 1 || byName["gone.txt"].Additions != 0 {
		t.Fatalf("gone.txt = %+v", byName["gone.txt"])
	}
}
