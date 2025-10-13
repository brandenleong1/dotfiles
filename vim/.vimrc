set nocompatible

let g:polyglot_disabled = ['sensible']

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

set list
set listchars=trail:·,tab:\→\ ,nbsp:␣,extends:›,precedes:‹
highlight SpecialKey ctermfg=248 ctermbg=NONE

set tabstop=4
set softtabstop=0 noexpandtab
set shiftwidth=4

syntax on
set hlsearch

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

