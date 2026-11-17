// Object layer: SHA-1 object ids, loose object construction and parsing
// (blobs, trees, commits), and tree surgery used by the contents API.
package git

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"forge/internal/store"
)

// zeroOID is 40 zero hex digits: the "no object" placeholder.
const zeroOID = "0000000000000000000000000000000000000000"

// hashBytes returns the git object id of one object: sha1("<type> <len>\0"+data).
func hashBytes(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ))
	h.Write([]byte(" "))
	h.Write([]byte(strconv.Itoa(len(data))))
	h.Write([]byte{0})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// HashObject returns the git object id for data of the given type.
func HashObject(typ string, data []byte) string {
	return hashBytes(typ, data)
}

// hexToBytes decodes a 40-char hex object id into 20 raw bytes.
func hexToBytes(sha string) ([]byte, error) {
	if len(sha) != 40 {
		return nil, fmt.Errorf("bad object id %q", sha)
	}
	b, err := hex.DecodeString(sha)
	if err != nil {
		return nil, fmt.Errorf("bad object id %q: %w", sha, err)
	}
	return b, nil
}

// TreeEntry is one entry of a git tree: Mode "100644" for a blob,
// "40000" for a subtree, Name the file name, SHA the child object id.
type TreeEntry struct {
	Mode string
	Name string
	SHA  string
}

// ParseTree decodes raw tree bytes into entries. A tree is a sequence of
// "<mode> <name>\0<20-byte sha>" records.
func ParseTree(data []byte) []TreeEntry {
	var out []TreeEntry
	for len(data) > 0 {
		sp := indexByte(data, ' ')
		if sp < 0 {
			return out
		}
		nul := indexByte(data[sp+1:], 0)
		if nul < 0 || sp+1+nul+20 > len(data) {
			return out
		}
		name := string(data[sp+1 : sp+1+nul])
		sha := hex.EncodeToString(data[sp+1+nul+1 : sp+1+nul+21])
		out = append(out, TreeEntry{Mode: string(data[:sp]), Name: name, SHA: sha})
		data = data[sp+1+nul+21:]
	}
	return out
}

// treeSortKey is the git tree sort key: directory names compare as if they
// ended with a slash.
func treeSortKey(e TreeEntry) string {
	if e.Mode == "40000" {
		return e.Name + "/"
	}
	return e.Name
}

// BuildTree encodes entries as raw tree bytes, sorted in git order.
func BuildTree(entries []TreeEntry) []byte {
	sorted := make([]TreeEntry, len(entries))
	copy(sorted, entries)
	sort.SliceStable(sorted, func(i, j int) bool {
		return treeSortKey(sorted[i]) < treeSortKey(sorted[j])
	})
	// Exact size up front: mode + space + name + NUL + 20 bytes per entry.
	size := 0
	for _, e := range sorted {
		size += len(e.Mode) + 1 + len(e.Name) + 1 + 20
	}
	out := make([]byte, 0, size)
	for _, e := range sorted {
		raw, err := hexToBytes(e.SHA)
		if err != nil {
			continue
		}
		out = append(out, e.Mode...)
		out = append(out, ' ')
		out = append(out, e.Name...)
		out = append(out, 0)
		out = append(out, raw...)
	}
	return out
}

// ParseCommit extracts the tree sha and parent shas from raw commit bytes.
func ParseCommit(data []byte) (tree string, parents []string) {
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "tree ") {
			tree = strings.TrimSpace(line[5:])
		} else if strings.HasPrefix(line, "parent ") {
			parents = append(parents, strings.TrimSpace(line[7:]))
		} else if line == "" {
			break
		}
	}
	return tree, parents
}

// parseTagTarget extracts the "object <sha>" line from raw tag bytes.
func parseTagTarget(data []byte) string {
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "object ") {
			return strings.TrimSpace(line[7:])
		}
		if line == "" {
			break
		}
	}
	return ""
}

// MakeBlob stores data as a blob object and returns its sha.
func MakeBlob(repo *store.Repo, data []byte) string {
	return repo.PutObject("blob", data)
}

// MakeTree stores entries as a tree object and returns its sha.
func MakeTree(repo *store.Repo, entries []TreeEntry) string {
	return repo.PutObject("tree", BuildTree(entries))
}

// commitIdent is the fixed author/committer line for every commit the
// forge creates: deterministic, from the fixed trial timestamp.
const commitIdent = "Heryp0401 <herrylf33@gmail.com> 1767225600 +0000"

// MakeCommit stores a commit object (tree, parents, fixed ident, message)
// and returns its sha.
func MakeCommit(repo *store.Repo, treeSHA string, parents []string, message string) string {
	var b strings.Builder
	b.WriteString("tree ")
	b.WriteString(treeSHA)
	b.WriteByte('\n')
	for _, p := range parents {
		b.WriteString("parent ")
		b.WriteString(p)
		b.WriteByte('\n')
	}
	b.WriteString("author ")
	b.WriteString(commitIdent)
	b.WriteByte('\n')
	b.WriteString("committer ")
	b.WriteString(commitIdent)
	b.WriteByte('\n')
	b.WriteByte('\n')
	b.WriteString(message)
	b.WriteByte('\n')
	return repo.PutObject("commit", []byte(b.String()))
}

// getTree returns the parsed entries of the tree object treeSHA, or nil
// when the tree does not exist (including the empty-tree case).
func getTree(repo *store.Repo, treeSHA string) []TreeEntry {
	if treeSHA == "" || treeSHA == zeroOID {
		return nil
	}
	obj := repo.GetObject(treeSHA)
	if obj == nil || obj.Type != "tree" {
		return nil
	}
	return ParseTree(obj.Data)
}

// UpdateTree returns the sha of a new tree equal to treeSHA except that
// the file at path holds blobSHA (or is removed when blobSHA is "").
// Intermediate trees are created as needed; trees left empty by a delete
// are dropped. The input tree is never mutated.
func UpdateTree(repo *store.Repo, treeSHA string, path string, blobSHA string) string {
	parts := strings.Split(path, "/")
	return updateTreeAt(repo, treeSHA, parts, blobSHA)
}

func updateTreeAt(repo *store.Repo, treeSHA string, parts []string, blobSHA string) string {
	entries := getTree(repo, treeSHA)
	if len(parts) == 1 {
		// Leaf level: replace, add, or remove the named entry.
		// Copy-on-write: never mutate the parsed slice.
		kept := append([]TreeEntry(nil), entries...)
		found := -1
		for i, e := range kept {
			if e.Name == parts[0] {
				found = i
				break
			}
		}
		if blobSHA == "" {
			if found < 0 {
				return treeSHA // nothing to delete
			}
			kept = append(kept[:found], kept[found+1:]...)
			if len(kept) == 0 {
				return ""
			}
			return MakeTree(repo, kept)
		}
		if found >= 0 {
			if kept[found].SHA == blobSHA && kept[found].Mode == "100644" {
				return treeSHA
			}
			kept[found] = TreeEntry{Mode: "100644", Name: parts[0], SHA: blobSHA}
		} else {
			kept = append(kept, TreeEntry{Mode: "100644", Name: parts[0], SHA: blobSHA})
		}
		return MakeTree(repo, kept)
	}
	// Directory level: recurse into the named subtree.
	kept := append([]TreeEntry(nil), entries...)
	found := -1
	for i, e := range kept {
		if e.Name == parts[0] {
			found = i
			break
		}
	}
	var childSHA string
	if found >= 0 {
		if kept[found].Mode != "40000" {
			// A blob sits where a directory is needed: replace it.
			childSHA = ""
		} else {
			childSHA = kept[found].SHA
		}
	}
	newChild := updateTreeAt(repo, childSHA, parts[1:], blobSHA)
	if newChild == childSHA {
		return treeSHA
	}
	if newChild == "" {
		if found < 0 {
			return treeSHA
		}
		kept = append(kept[:found], kept[found+1:]...)
		if len(kept) == 0 {
			return ""
		}
		return MakeTree(repo, kept)
	}
	if found >= 0 {
		kept[found] = TreeEntry{Mode: "40000", Name: parts[0], SHA: newChild}
	} else {
		kept = append(kept, TreeEntry{Mode: "40000", Name: parts[0], SHA: newChild})
	}
	return MakeTree(repo, kept)
}

// LookupPath walks treeSHA along path and returns the object id, its kind
// ("blob" or "tree") and whether it was found.
func LookupPath(repo *store.Repo, treeSHA string, path string) (sha string, typ string, found bool) {
	if path == "" {
		return treeSHA, "tree", treeSHA != ""
	}
	parts := strings.Split(path, "/")
	cur := treeSHA
	for i, part := range parts {
		entries := getTree(repo, cur)
		hit := false
		for _, e := range entries {
			if e.Name != part {
				continue
			}
			hit = true
			if i == len(parts)-1 {
				if e.Mode == "40000" {
					return e.SHA, "tree", true
				}
				return e.SHA, "blob", true
			}
			if e.Mode != "40000" {
				return "", "", false
			}
			cur = e.SHA
			break
		}
		if !hit {
			return "", "", false
		}
	}
	return "", "", false
}

// ListDir returns the entries of the directory at path inside treeSHA, or
// nil when path is not a directory ("" is the tree root itself).
func ListDir(repo *store.Repo, treeSHA string, path string) []TreeEntry {
	if path == "" {
		return getTree(repo, treeSHA)
	}
	sha, typ, found := LookupPath(repo, treeSHA, path)
	if !found || typ != "tree" {
		return nil
	}
	return getTree(repo, sha)
}

// indexByte is bytes.IndexByte without importing bytes here.
func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}
