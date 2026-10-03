set nocompatible

filetype plugin indent on

let g:polyglot_disabled = ['sensible']
let g:stabs_maps = 'tboO='
let g:gutentags_enabled = executable('ctags')

set number
set relativenumber
autocmd InsertEnter * :set norelativenumber
autocmd InsertLeave * :set relativenumber

set t_Co=256

set cursorline
highlight CursorLine ctermbg=NONE guibg=NONE

set tags=./tags;/

set autoread
set smartindent
set autoindent
set smarttab

set hidden

set showcmd

" au BufWritePost *.c,*.cpp,*.h,*.py silent! !ctags -R &
" autocmd FocusGained,BufEnter * :checktime

if !isdirectory($HOME . '/.vim/tmp')
	call mkdir($HOME . '/.vim/tmp', 'p')
endif
set directory=~/.vim/tmp//

set list
set listchars=trail:·,tab:\→\ ,nbsp:␣,extends:›,precedes:‹
highlight SpecialKey ctermfg=248 ctermbg=NONE

set tabstop=4
set softtabstop=0 noexpandtab

set shiftwidth=4
set scrolloff=4

syntax on
set hlsearch
set incsearch

set updatetime=500
set signcolumn=auto

highlight SignColumn guibg=NONE ctermbg=NONE

nnoremap <C-n> :NERDTree<CR>
nnoremap <C-t> :NERDTreeToggle<CR>
nnoremap <C-f> :NERDTreeFind<CR>

let NERDTreeCustomOpenArgs={'file': {'where': 't'}}
let NERDTreeShowHidden=1

highlight GitGutterAdd guifg=#009900 ctermfg=2 guibg=NONE ctermbg=NONE
highlight GitGutterChange guifg=#bbbb00 ctermfg=3 guibg=NONE ctermbg=NONE
highlight GitGutterDelete guifg=#ff2222 ctermfg=1 guibg=NONE ctermbg=NONE

let g:airline_theme = 'papercolor'
let g:airline#extensions#tabline#enabled = 1
let g:airline#extensions#tabline#formatter = 'unique_tail_improved'
let g:airline_section_z = '%p%% ☰ %l/%L ln : %c'

autocmd BufRead,BufNewFile *.lean setfiletype lean
autocmd FileType lean setlocal expandtab tabstop=2 shiftwidth=2 softtabstop=2 | let b:smarttabs_enabled = 0

" LSP for Vim >9.0
if has('patch-9.0.0000') && has('job') && has('channel')
	let s:lsp_package = globpath(&packpath, 'pack/vendor/opt/lsp')

	if !empty(s:lsp_package)
		let g:lsp_options = {
			\ 'autoComplete': v:true,
			\ 'autoHighlightDiags': v:true,
			\ 'showDiagInPopup': v:true,
			\ 'showDiagWithVirtualText': v:false,
			\ 'showSignature': v:true,
			\ }

		let g:lsp_servers = []

		if executable('clangd')
			call add(g:lsp_servers, {
				\ 'name': 'clangd',
				\ 'filetype': ['c', 'cpp'],
				\ 'path': exepath('clangd'),
				\ 'args': ['--background-index', '--clang-tidy'],
				\ 'rootSearch': ['compile_commands.json', 'compile_flags.txt', '.git/'],
				\ })
		endif

		let s:pyright = exepath('pyright-langserver')
		if empty(s:pyright)
			let s:pyright = expand('~/.local/bin/pyright-langserver')
		endif
		if executable(s:pyright)
			call add(g:lsp_servers, {
				\ 'name': 'pyright',
				\ 'filetype': 'python',
				\ 'path': s:pyright,
				\ 'args': ['--stdio'],
				\ 'rootSearch': ['pyrightconfig.json', 'pyproject.toml', 'setup.py', '.git/'],
				\ })
		endif

		let s:lake = exepath('lake')
		if empty(s:lake)
			let s:lake = expand('~/.elan/bin/lake')
		endif
		if executable(s:lake)
			call add(g:lsp_servers, {
				\ 'name': 'lean',
				\ 'filetype': 'lean',
				\ 'path': s:lake,
				\ 'args': ['serve'],
				\ 'rootSearch': ['lakefile.lean', 'lakefile.toml', 'lean-toolchain', '.git/'],
				\ 'runIfSearch': ['lakefile.lean', 'lakefile.toml', 'lean-toolchain'],
				\ })
		endif

		packadd lsp

		augroup dotfiles_lsp
			autocmd!
			autocmd User LspAttached nnoremap <buffer> <silent> gd <Cmd>LspGotoDefinition<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>pd <Cmd>LspPeekDefinition<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> gr <Cmd>LspShowReferences<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>pr <Cmd>LspPeekReferences<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> gi <Cmd>LspGotoImpl<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>pi <Cmd>LspPeekImpl<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> gy <Cmd>LspGotoTypeDef<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>py <Cmd>LspPeekTypeDef<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> K <Cmd>LspHover<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> [d <Cmd>LspDiag prev<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> ]d <Cmd>LspDiag next<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>rn <Cmd>LspRename<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>ca <Cmd>LspCodeAction<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>f <Cmd>LspFormat<CR>
			autocmd User LspAttached nnoremap <buffer> <silent> <Leader>sh <Cmd>LspSwitchSourceHeader<CR>
		augroup END
	endif
endif
