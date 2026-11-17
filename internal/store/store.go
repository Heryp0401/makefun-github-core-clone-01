// Package store holds the forge's in-memory state: repositories, git
// objects, refs, issues and pull requests.
//
// Locking convention: the exported Mu guards every field. Callers hold
// s.Mu (RLock for reads, Lock for mutations) around GetRepo and CreateRepo;
// those two methods do not lock internally. Viewer and LearnViewer lock
// internally because the server wrapper calls them without holding Mu.
// Response bytes are always built while the lock is held and written to the
// network only after the lock is released.
package store

import (
	"crypto/sha1"
	"encoding/hex"
	"strconv"
	"sync"

	"forge/internal/util"
)

// Object is one git object: a commit, tree, blob or tag.
type Object struct {
	Type string // "commit" | "tree" | "blob" | "tag"
	Data []byte
}

// Comment is one comment on an issue.
type Comment struct {
	ID        int
	Body      string
	CreatedAt string
	UpdatedAt string
}

// Issue is one repository issue. JSON holds the pre-serialized GET-single
// response; nil means the JSON must be rebuilt from the fields.
type Issue struct {
	Number    int
	Title     string
	Body      string
	State     string // "open" | "closed"
	Labels    []string
	Comments  []*Comment
	CreatedAt string
	UpdatedAt string
	JSON      []byte
}

// PullFile is one changed file of a pull request, as the files endpoint
// reports it.
type PullFile struct {
	Filename  string
	Status    string
	Additions int
	Deletions int
	Changes   int
}

// Pull is one repository pull request.
type Pull struct {
	Number         int
	Title          string
	Body           string
	State          string // "open" | "closed"
	HeadRef        string
	HeadSHA        string
	BaseRef        string
	BaseSHA        string
	Merged         bool
	Mergeable      string // "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
	MergedAt       string
	MergeCommitSHA string
	Files          []PullFile
}

// Label is one repository label.
type Label struct {
	Name  string
	Color string
}

// Repo is one repository with its full git object store and trackers.
type Repo struct {
	Owner          string
	Name           string
	Private        bool
	DefaultBranch  string // "main"
	Description    string
	CreatedAt      string
	UpdatedAt      string
	DatabaseID     int
	Refs           map[string]string // "refs/heads/main" -> SHA
	Objects        map[string]*Object
	Issues         []*Issue
	Pulls          []*Pull
	Labels         map[string]*Label
	NextIssue      int
	NextPull       int
	NextCommentID  int // all counters start at 1
	HeadPackBuf    []byte
	HeadPackTip    string
	HeadPackDeepen int
}

// GetObject returns the object with the given SHA, or nil.
func (r *Repo) GetObject(sha string) *Object {
	return r.Objects[sha]
}

// PutObject stores data as an object of the given type when it is new and
// returns its SHA-1, computed over "type len\0" + data.
func (r *Repo) PutObject(typ string, data []byte) string {
	h := sha1.New()
	h.Write([]byte(typ))
	h.Write([]byte(" "))
	h.Write([]byte(strconv.Itoa(len(data))))
	h.Write([]byte{0})
	h.Write(data)
	sha := hex.EncodeToString(h.Sum(nil))
	if _, ok := r.Objects[sha]; !ok {
		r.Objects[sha] = &Object{Type: typ, Data: data}
	}
	return sha
}

// Ref returns the SHA a ref points at, or "" when the ref does not exist.
func (r *Repo) Ref(name string) string {
	return r.Refs[name]
}

// SetRef points a ref at a SHA.
func (r *Repo) SetRef(name, sha string) {
	r.Refs[name] = sha
}

// Store is the whole forge state.
type Store struct {
	Mu          sync.RWMutex
	Repos       map[string]*Repo
	ViewerLogin string
	Token       string
	NextDBID    int
}

// NewStore creates an empty store for the given bearer token.
func NewStore(token string) *Store {
	return &Store{
		Repos:    make(map[string]*Repo),
		Token:    token,
		NextDBID: 1,
	}
}

// Key is the map key for a repository: owner + "/" + name.
func (s *Store) Key(owner, name string) string {
	return owner + "/" + name
}

// GetRepo returns the repository owned by owner with the given name, or nil.
// The caller must hold s.Mu (RLock is enough).
func (s *Store) GetRepo(owner, name string) *Repo {
	return s.Repos[s.Key(owner, name)]
}

// CreateRepo creates a repository owned by owner, or returns the existing
// one when the name is already taken. The caller must hold s.Mu with Lock.
func (s *Store) CreateRepo(owner, name string, private bool, description string) *Repo {
	if existing := s.Repos[s.Key(owner, name)]; existing != nil {
		return existing
	}
	repo := &Repo{
		Owner:         owner,
		Name:          name,
		Private:       private,
		DefaultBranch: "main",
		Description:   description,
		CreatedAt:     util.Now(),
		UpdatedAt:     util.Now(),
		DatabaseID:    s.NextDBID,
		Refs:          make(map[string]string),
		Objects:       make(map[string]*Object),
		Issues:        make([]*Issue, 0),
		Pulls:         make([]*Pull, 0),
		Labels:        make(map[string]*Label),
		NextIssue:     1,
		NextPull:      1,
		NextCommentID: 1,
	}
	s.NextDBID++
	s.Repos[s.Key(owner, name)] = repo
	return repo
}

// Viewer returns the login that owns the repositories, falling back to the
// raw token when no login has been learned yet.
func (s *Store) Viewer() string {
	s.Mu.RLock()
	defer s.Mu.RUnlock()
	if s.ViewerLogin != "" {
		return s.ViewerLogin
	}
	return s.Token
}

// LearnViewer records the viewer login the first time one is seen; later
// calls are no-ops.
func (s *Store) LearnViewer(owner string) {
	if owner == "" {
		return
	}
	s.Mu.Lock()
	defer s.Mu.Unlock()
	if s.ViewerLogin == "" {
		s.ViewerLogin = owner
	}
}
