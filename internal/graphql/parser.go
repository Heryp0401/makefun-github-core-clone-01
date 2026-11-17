package graphql

import (
	"fmt"
)

// ValueKind classifies one parsed argument value.
type ValueKind int

const (
	KindNull ValueKind = iota
	KindString
	KindInt
	KindFloat
	KindBool
	KindEnum
	KindVar
	KindList
	KindObject
)

// Value is one parsed GraphQL value: a scalar, a variable reference, a
// list, or an inline input object. Enum names and strings are both kept as
// Str; Kind tells them apart.
type Value struct {
	Kind ValueKind
	Str  string
	Num  float64
	Bool bool
	List []Value
	Obj  []ObjectField
	Var  string
}

// ObjectField is one field of an inline input object.
type ObjectField struct {
	Name  string
	Value Value
}

// Argument is one field argument: name: value.
type Argument struct {
	Name  string
	Value Value
}

// Field is one selection: [alias:] name[(args)][@directives][selection set].
type Field struct {
	Alias  string
	Name   string
	Args   []Argument
	SelSet *SelectionSet
}

// InlineFragment is "... on Type { ... }" (or "... { ... }").
type InlineFragment struct {
	TypeCond string
	SelSet   *SelectionSet
}

// FragmentSpread is "...Name".
type FragmentSpread struct {
	Name string
}

// Selection is one item of a selection set.
type Selection interface{ isSelection() }

func (*Field) isSelection()          {}
func (*InlineFragment) isSelection() {}
func (*FragmentSpread) isSelection() {}

// SelectionSet is a brace-delimited list of selections.
type SelectionSet struct {
	Selections []Selection
}

// VarDef is one variable definition: $name: Type = default.
type VarDef struct {
	Name    string
	Type    string
	Default *Value
}

// Operation is one query/mutation definition.
type Operation struct {
	Type    string // "query" or "mutation"
	Name    string
	VarDefs []VarDef
	SelSet  *SelectionSet
}

// FragmentDef is a named fragment definition.
type FragmentDef struct {
	Name     string
	TypeCond string
	SelSet   *SelectionSet
}

// Document is a whole parsed GraphQL document.
type Document struct {
	Operations []*Operation
	Fragments  map[string]*FragmentDef
}

// Parser is a recursive-descent parser over a Lexer. It keeps one token of
// lookahead in cur.
type Parser struct {
	lex *Lexer
	cur Token
}

// ParseDocument parses src into a Document.
func ParseDocument(src string) (*Document, error) {
	p := &Parser{lex: NewLexer(src)}
	p.cur = p.lex.Next()
	doc := &Document{Fragments: map[string]*FragmentDef{}}
	for p.cur.Kind != TokEOF {
		if p.cur.Kind == TokLBrace {
			ss, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			doc.Operations = append(doc.Operations, &Operation{Type: "query", SelSet: ss})
			continue
		}
		if p.cur.Kind != TokIdent {
			return nil, fmt.Errorf("unexpected token %q at %d", p.cur.Lit, p.cur.Pos)
		}
		switch p.cur.Lit {
		case "query", "mutation", "subscription":
			op, err := p.parseOperation()
			if err != nil {
				return nil, err
			}
			doc.Operations = append(doc.Operations, op)
		case "fragment":
			fd, err := p.parseFragmentDef()
			if err != nil {
				return nil, err
			}
			doc.Fragments[fd.Name] = fd
		default:
			return nil, fmt.Errorf("unexpected keyword %q at %d", p.cur.Lit, p.cur.Pos)
		}
	}
	if len(doc.Operations) == 0 {
		return nil, fmt.Errorf("empty document")
	}
	return doc, nil
}

func (p *Parser) next() Token {
	t := p.cur
	p.cur = p.lex.Next()
	return t
}

func (p *Parser) expect(kind TokenKind) (Token, error) {
	if p.cur.Kind != kind {
		return Token{}, fmt.Errorf("expected token %d, got %q at %d", kind, p.cur.Lit, p.cur.Pos)
	}
	return p.next(), nil
}

func (p *Parser) expectIdent() (string, error) {
	if p.cur.Kind != TokIdent {
		return "", fmt.Errorf("expected name, got %q at %d", p.cur.Lit, p.cur.Pos)
	}
	return p.next().Lit, nil
}

func (p *Parser) parseOperation() (*Operation, error) {
	op := &Operation{Type: p.next().Lit}
	if p.cur.Kind == TokIdent {
		op.Name = p.next().Lit
	}
	if p.cur.Kind == TokLParen {
		defs, err := p.parseVarDefs()
		if err != nil {
			return nil, err
		}
		op.VarDefs = defs
	}
	if err := p.skipDirectives(); err != nil {
		return nil, err
	}
	ss, err := p.parseSelectionSet()
	if err != nil {
		return nil, err
	}
	op.SelSet = ss
	return op, nil
}

func (p *Parser) parseVarDefs() ([]VarDef, error) {
	if _, err := p.expect(TokLParen); err != nil {
		return nil, err
	}
	var defs []VarDef
	for p.cur.Kind != TokRParen {
		if p.cur.Kind == TokEOF {
			return nil, fmt.Errorf("unterminated variable definitions")
		}
		if _, err := p.expect(TokDollar); err != nil {
			return nil, err
		}
		name, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(TokColon); err != nil {
			return nil, err
		}
		typ, err := p.parseType()
		if err != nil {
			return nil, err
		}
		def := VarDef{Name: name, Type: typ}
		if p.cur.Kind == TokEquals {
			p.next()
			v, err := p.parseValue()
			if err != nil {
				return nil, err
			}
			def.Default = &v
		}
		defs = append(defs, def)
	}
	if _, err := p.expect(TokRParen); err != nil {
		return nil, err
	}
	return defs, nil
}

// parseType reads a type reference ([T], T!, T) as a plain string; the
// executor only needs the spelling for diagnostics, not validation.
func (p *Parser) parseType() (string, error) {
	var s string
	switch p.cur.Kind {
	case TokLBracket:
		p.next()
		inner, err := p.parseType()
		if err != nil {
			return "", err
		}
		if _, err := p.expect(TokRBracket); err != nil {
			return "", err
		}
		s = "[" + inner + "]"
	case TokIdent:
		s = p.next().Lit
	default:
		return "", fmt.Errorf("expected type, got %q at %d", p.cur.Lit, p.cur.Pos)
	}
	if p.cur.Kind == TokBang {
		p.next()
		s += "!"
	}
	return s, nil
}

func (p *Parser) parseFragmentDef() (*FragmentDef, error) {
	p.next() // "fragment"
	name, err := p.expectIdent()
	if err != nil {
		return nil, err
	}
	if p.cur.Kind != TokIdent || p.cur.Lit != "on" {
		return nil, fmt.Errorf("expected 'on' in fragment definition at %d", p.cur.Pos)
	}
	p.next()
	cond, err := p.expectIdent()
	if err != nil {
		return nil, err
	}
	if err := p.skipDirectives(); err != nil {
		return nil, err
	}
	ss, err := p.parseSelectionSet()
	if err != nil {
		return nil, err
	}
	return &FragmentDef{Name: name, TypeCond: cond, SelSet: ss}, nil
}

func (p *Parser) parseSelectionSet() (*SelectionSet, error) {
	if _, err := p.expect(TokLBrace); err != nil {
		return nil, err
	}
	ss := &SelectionSet{}
	for p.cur.Kind != TokRBrace {
		if p.cur.Kind == TokEOF {
			return nil, fmt.Errorf("unterminated selection set")
		}
		sel, err := p.parseSelection()
		if err != nil {
			return nil, err
		}
		ss.Selections = append(ss.Selections, sel)
	}
	if _, err := p.expect(TokRBrace); err != nil {
		return nil, err
	}
	return ss, nil
}

func (p *Parser) parseSelection() (Selection, error) {
	if p.cur.Kind == TokEllipsis {
		p.next()
		if p.cur.Kind == TokIdent && p.cur.Lit == "on" {
			p.next()
			cond, err := p.expectIdent()
			if err != nil {
				return nil, err
			}
			if err := p.skipDirectives(); err != nil {
				return nil, err
			}
			ss, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			return &InlineFragment{TypeCond: cond, SelSet: ss}, nil
		}
		if p.cur.Kind == TokLBrace {
			ss, err := p.parseSelectionSet()
			if err != nil {
				return nil, err
			}
			return &InlineFragment{SelSet: ss}, nil
		}
		name, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		if err := p.skipDirectives(); err != nil {
			return nil, err
		}
		return &FragmentSpread{Name: name}, nil
	}
	return p.parseField()
}

func (p *Parser) parseField() (*Field, error) {
	name, err := p.expectIdent()
	if err != nil {
		return nil, err
	}
	f := &Field{Name: name}
	if p.cur.Kind == TokColon {
		p.next()
		real, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		f.Alias = name
		f.Name = real
	}
	if p.cur.Kind == TokLParen {
		args, err := p.parseArguments()
		if err != nil {
			return nil, err
		}
		f.Args = args
	}
	if err := p.skipDirectives(); err != nil {
		return nil, err
	}
	if p.cur.Kind == TokLBrace {
		ss, err := p.parseSelectionSet()
		if err != nil {
			return nil, err
		}
		f.SelSet = ss
	}
	return f, nil
}

func (p *Parser) parseArguments() ([]Argument, error) {
	if _, err := p.expect(TokLParen); err != nil {
		return nil, err
	}
	var args []Argument
	for p.cur.Kind != TokRParen {
		if p.cur.Kind == TokEOF {
			return nil, fmt.Errorf("unterminated arguments")
		}
		name, err := p.expectIdent()
		if err != nil {
			return nil, err
		}
		if _, err := p.expect(TokColon); err != nil {
			return nil, err
		}
		v, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		args = append(args, Argument{Name: name, Value: v})
	}
	if _, err := p.expect(TokRParen); err != nil {
		return nil, err
	}
	return args, nil
}

// parseValue parses one argument value: scalar, variable, enum, list,
// inline input object, or null.
func (p *Parser) parseValue() (Value, error) {
	t := p.cur
	switch t.Kind {
	case TokString:
		p.next()
		return Value{Kind: KindString, Str: t.Lit}, nil
	case TokInt:
		p.next()
		var n float64
		_, _ = fmt.Sscanf(t.Lit, "%g", &n)
		return Value{Kind: KindInt, Str: t.Lit, Num: n}, nil
	case TokFloat:
		p.next()
		var n float64
		_, _ = fmt.Sscanf(t.Lit, "%g", &n)
		return Value{Kind: KindFloat, Str: t.Lit, Num: n}, nil
	case TokDollar:
		p.next()
		name, err := p.expectIdent()
		if err != nil {
			return Value{}, err
		}
		return Value{Kind: KindVar, Var: name}, nil
	case TokLBracket:
		p.next()
		var elems []Value
		for p.cur.Kind != TokRBracket {
			if p.cur.Kind == TokEOF {
				return Value{}, fmt.Errorf("unterminated list value")
			}
			v, err := p.parseValue()
			if err != nil {
				return Value{}, err
			}
			elems = append(elems, v)
		}
		if _, err := p.expect(TokRBracket); err != nil {
			return Value{}, err
		}
		return Value{Kind: KindList, List: elems}, nil
	case TokLBrace:
		p.next()
		var fields []ObjectField
		for p.cur.Kind != TokRBrace {
			if p.cur.Kind == TokEOF {
				return Value{}, fmt.Errorf("unterminated input object")
			}
			name, err := p.expectIdent()
			if err != nil {
				return Value{}, err
			}
			if _, err := p.expect(TokColon); err != nil {
				return Value{}, err
			}
			v, err := p.parseValue()
			if err != nil {
				return Value{}, err
			}
			fields = append(fields, ObjectField{Name: name, Value: v})
		}
		if _, err := p.expect(TokRBrace); err != nil {
			return Value{}, err
		}
		return Value{Kind: KindObject, Obj: fields}, nil
	case TokIdent:
		p.next()
		switch t.Lit {
		case "true":
			return Value{Kind: KindBool, Bool: true}, nil
		case "false":
			return Value{Kind: KindBool, Bool: false}, nil
		case "null":
			return Value{Kind: KindNull}, nil
		default:
			return Value{Kind: KindEnum, Str: t.Lit}, nil
		}
	}
	return Value{}, fmt.Errorf("unexpected value token %q at %d", t.Lit, t.Pos)
}

// skipDirectives consumes @name[(args)] sequences, ignoring them.
func (p *Parser) skipDirectives() error {
	for p.cur.Kind == TokAt {
		p.next()
		if _, err := p.expectIdent(); err != nil {
			return err
		}
		if p.cur.Kind == TokLParen {
			if _, err := p.parseArguments(); err != nil {
				return err
			}
		}
	}
	return nil
}
