# Vim

Run `install.sh` for automatic installation. For manual installation, follow the instructions below.

Place `.vimrc` in the home directory (`~/.vimrc`)

Clone regular pack repos in `~/.vim/pack/*/start` and optional pack repos in `~/.vim/pack/*/opt` (replace `*` with anything, perhaps `vendor`).

### Packs

* NERDTree - [preservim/nerdtree](https://github.com/preservim/nerdtree)
* vim-gitgutter - [airblade/vim-gitgutter](https://github.com/airblade/vim-gitgutter)
* vim-polyglot - [sheerun/vim-polyglot](https://github.com/sheerun/vim-polyglot)
* vim-airline - [vim-airline/vim-airline](https://github.com/vim-airline/vim-airline)
* vim-airline-themes - [vim-airline/vim-airline-themes](https://github.com/vim-airline/vim-airline-themes)
* vim-fugitive - [tpope/vim-fugitive](https://github.com/tpope/vim-fugitive)
* vim-gutentags - [ludovicchabant/vim-gutentags](https://github.com/ludovicchabant/vim-gutentags)
* vim-stabs - [Thyrum/vim-stabs](https://github.com/Thyrum/vim-stabs)

#### Optional:

* LSP - [yegappan/lsp](https://github.com/yegappan/lsp) (optional pack)

### LSP

LSP support requires Vim 9 or newer with `+job` and `+channel`. The configuration is skipped automatically on unsupported Vim versions.

Install the language servers separately:

* C/C++ - `clangd`
    * `sudo apt install clangd` (Ubuntu)
* Python - `pyright-langserver`
    * `npm install --global --prefix ~/.local pyright`
* Lean - `lake`
    * `curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`
