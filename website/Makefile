# GNO Documentation Website

.PHONY: install serve build clean

# Install Ruby dependencies
install:
	bundle install

# Copy docs and start dev server with live reload
serve: sync-docs
	bundle exec jekyll serve --livereload --port 4000

# Copy docs and build static site
build: sync-docs
	bundle exec jekyll build

# Copy docs from parent directory (excludes internal NOTES.md)
sync-docs:
	@mkdir -p docs
	@for f in ../docs/*.md; do \
		case "$$(basename $$f)" in \
			NOTES.md) ;; \
			*) cp "$$f" docs/ ;; \
		esac; \
	done
	@echo "Synced docs from ../docs/ (excluding NOTES.md)"

# Clean build artifacts
clean:
	rm -rf _site .jekyll-cache .sass-cache docs/

# Full rebuild
rebuild: clean build
