package store

import (
	"crypto/sha1"
	"encoding/hex"
	"strconv"
	"testing"
)

func TestKey(t *testing.T) {
	s := NewStore("tok")
	if got := s.Key("alice", "demo"); got != "alice/demo" {
		t.Fatalf("Key = %q, want alice/demo", got)
	}
}

func TestViewerFallbackAndLearn(t *testing.T) {
	s := NewStore("tok-123")
	if got := s.Viewer(); got != "tok-123" {
		t.Fatalf("Viewer before learn = %q, want token", got)
	}
	s.LearnViewer("alice")
	if got := s.Viewer(); got != "alice" {
		t.Fatalf("Viewer after learn = %q, want alice", got)
	}
	s.LearnViewer("mallory")
	if got := s.Viewer(); got != "alice" {
		t.Fatalf("Viewer after second learn = %q, want alice (first wins)", got)
	}
}

func TestCreateAndGetRepo(t *testing.T) {
	s := NewStore("tok")
	s.Mu.Lock()
	r := s.CreateRepo("alice", "demo", true, "a demo repo")
	s.Mu.Unlock()
	if r.Owner != "alice" || r.Name != "demo" || !r.Private {
		t.Fatalf("repo fields wrong: %+v", r)
	}
	if r.DefaultBranch != "main" {
		t.Fatalf("DefaultBranch = %q, want main", r.DefaultBranch)
	}
	if r.DatabaseID != 1 {
		t.Fatalf("DatabaseID = %d, want 1", r.DatabaseID)
	}
	if r.NextIssue != 1 || r.NextPull != 1 || r.NextCommentID != 1 {
		t.Fatalf("counters must start at 1: %+v", r)
	}
	if r.Refs == nil || r.Objects == nil || r.Labels == nil {
		t.Fatalf("maps must be initialized")
	}
	if r.Issues == nil || r.Pulls == nil {
		t.Fatalf("slices must be non-nil")
	}

	s.Mu.RLock()
	got := s.GetRepo("alice", "demo")
	s.Mu.RUnlock()
	if got != r {
		t.Fatalf("GetRepo returned a different repo")
	}
	s.Mu.RLock()
	missing := s.GetRepo("alice", "nope")
	s.Mu.RUnlock()
	if missing != nil {
		t.Fatalf("GetRepo of a missing repo must be nil")
	}

	// Creating the same name again returns the existing repo.
	s.Mu.Lock()
	again := s.CreateRepo("alice", "demo", false, "other")
	s.Mu.Unlock()
	if again != r {
		t.Fatalf("duplicate CreateRepo must return the existing repo")
	}
	if again.Description != "a demo repo" {
		t.Fatalf("duplicate CreateRepo must not overwrite: %q", again.Description)
	}
}

func TestPutGetObject(t *testing.T) {
	s := NewStore("tok")
	s.Mu.Lock()
	r := s.CreateRepo("alice", "demo", false, "")
	s.Mu.Unlock()

	data := []byte("hello world\n")
	sha := r.PutObject("blob", data)

	// Expected SHA-1 over "blob <len>\0" + data.
	h := sha1.New()
	h.Write([]byte("blob " + strconv.Itoa(len(data)) + "\x00"))
	h.Write(data)
	want := hex.EncodeToString(h.Sum(nil))
	if sha != want {
		t.Fatalf("PutObject sha = %s, want %s", sha, want)
	}
	if len(sha) != 40 {
		t.Fatalf("sha length = %d, want 40", len(sha))
	}
	obj := r.GetObject(sha)
	if obj == nil || obj.Type != "blob" || string(obj.Data) != string(data) {
		t.Fatalf("GetObject roundtrip failed: %+v", obj)
	}
	if r.GetObject("0000000000000000000000000000000000000000") != nil {
		t.Fatalf("GetObject of an unknown sha must be nil")
	}

	// Storing the same blob again is a no-op (same sha, one object).
	sha2 := r.PutObject("blob", data)
	if sha2 != sha {
		t.Fatalf("second PutObject sha = %s, want %s", sha2, sha)
	}
	if len(r.Objects) != 1 {
		t.Fatalf("Objects = %d entries, want 1", len(r.Objects))
	}
}

func TestRef(t *testing.T) {
	s := NewStore("tok")
	s.Mu.Lock()
	r := s.CreateRepo("alice", "demo", false, "")
	s.Mu.Unlock()
	if got := r.Ref("refs/heads/main"); got != "" {
		t.Fatalf("missing ref = %q, want empty", got)
	}
	r.SetRef("refs/heads/main", "aabbcc")
	if got := r.Ref("refs/heads/main"); got != "aabbcc" {
		t.Fatalf("ref = %q, want aabbcc", got)
	}
	r.SetRef("refs/heads/main", "ddeeff")
	if got := r.Ref("refs/heads/main"); got != "ddeeff" {
		t.Fatalf("ref after move = %q, want ddeeff", got)
	}
}
