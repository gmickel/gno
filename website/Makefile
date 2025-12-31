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
	@# Copy subdirectories (comparisons, integrations, etc.)
	@for dir in ../docs/*/; do \
		if [ -d "$$dir" ]; then \
			dirname=$$(basename "$$dir"); \
			mkdir -p "docs/$$dirname"; \
			cp -r "$$dir"* "docs/$$dirname/" 2>/dev/null || true; \
		fi; \
	done
	@echo "Synced docs from ../docs/ (excluding NOTES.md)"
	@{ \
		echo '---'; \
		echo 'layout: page'; \
		echo 'title: Changelog'; \
		echo 'description: Release history and version notes for GNO'; \
		echo 'permalink: /changelog/'; \
		echo '---'; \
		echo ''; \
		tail -n +3 ../CHANGELOG.md; \
		echo ''; \
		echo '[View on GitHub](https://github.com/gmickel/gno/blob/main/CHANGELOG.md)'; \
	} > changelog.md
	@echo "Synced CHANGELOG.md"

# Clean build artifacts
clean:
	rm -rf _site .jekyll-cache .sass-cache docs/

# Full rebuild
rebuild: clean build
