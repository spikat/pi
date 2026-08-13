EXTENSIONS := commit-msg pr-description review commands-whitelist web
OTP ?=
PUBLISH_ARGS := --access public $(if $(OTP),--otp=$(OTP))

.PHONY: publish

# Pass a current 2FA code with: make publish OTP=123456
# A granular npm token configured with 2FA bypass does not require OTP.
publish:
	@set -e; \
	for extension in $(EXTENSIONS); do \
		package="$$(node -p "require('./$$extension/package.json').name")"; \
		version="$$(node -p "require('./$$extension/package.json').version")"; \
		if npm view --prefer-online --cache-min=0 "$$package@$$version" version >/dev/null 2>&1; then \
			printf 'Skipping %s@%s: version is already published.\n' "$$package" "$$version"; \
		else \
			printf '\nPublishing %s@%s...\n' "$$package" "$$version"; \
			if output="$$(cd "$$extension" && npm publish $(PUBLISH_ARGS) 2>&1)"; then \
				printf '%s\n' "$$output"; \
			elif printf '%s' "$$output" | grep -Fq 'You cannot publish over the previously published versions'; then \
				printf 'Skipping %s@%s: version is already published.\n' "$$package" "$$version"; \
			else \
				printf '%s\n' "$$output" >&2; \
				exit 1; \
			fi; \
		fi; \
	done
