" Basic Lean 4 syntax highlighting. LSP semantic tokens refine these groups
" after the Lean language server attaches.

if exists('b:current_syntax')
	finish
endif

syntax case match

syntax keyword leanCommand
	\ import prelude namespace section end open export
	\ private protected public scoped local
	\ variable variables include omit universe universes
	\ initialize builtin macro_rules

syntax keyword leanDeclaration
	\ def abbrev opaque theorem lemma example axiom
	\ inductive coinductive structure class instance
	\ syntax macro notation infix infixl infixr prefix postfix

syntax keyword leanModifier
	\ partial unsafe noncomputable mutual where deriving extends

syntax keyword leanConditional
	\ if then else match with

syntax keyword leanStatement
	\ let in fun forall do by return from have show calc

syntax keyword leanTactic
	\ intro intros apply exact refine assumption constructor
	\ cases induction simp simpa rw rfl decide omega aesop

syntax keyword leanType
	\ Prop Type Sort Nat Int UInt Float Bool Char String
	\ Array List Option Except IO Unit

syntax keyword leanBoolean true false
syntax keyword leanTodo sorry admit

syntax match leanCommand '#\%(check\|eval\|reduce\|print\|synth\|guard\|lint\)\>'
syntax match leanAttribute '@\[[^]]\+\]'
syntax match leanNumber '\<\d\+\%(\.\d\+\)\?\>'
syntax match leanOperator '[:=|<>+\-*/^&!?~]\+'
syntax match leanOperator '[∀∃→←↔λ≤≥≠∧∨¬⊢⊣]'

syntax match leanEscape contained '\\\(.\|x\x\{2}\|u\x\{4}\)'
syntax region leanString start=+"+ skip=+\\\\\|\\"+ end=+"+ contains=leanEscape

syntax match leanLineComment '--.*$' contains=@Spell
syntax region leanBlockComment start='/-' end='-/' contains=leanBlockComment,@Spell keepend extend

highlight default link leanCommand PreProc
highlight default link leanDeclaration Keyword
highlight default link leanModifier StorageClass
highlight default link leanConditional Conditional
highlight default link leanStatement Statement
highlight default link leanTactic Function
highlight default link leanType Type
highlight default link leanBoolean Boolean
highlight default link leanTodo Todo
highlight default link leanAttribute Special
highlight default link leanNumber Number
highlight default link leanOperator Operator
highlight default link leanEscape SpecialChar
highlight default link leanString String
highlight default link leanLineComment Comment
highlight default link leanBlockComment Comment

let b:current_syntax = 'lean'
