# Contributor instructions

Keep the product audit limited to documented font size and text color. Source intent must be independent from target styling. Review rules/mappings before enforcement. Show grouped errors with screenshot evidence, not matches. Unsupported or failed coverage is not a full pass.

Keep credentials and private user data out of source and tests. Use synthetic fixtures. Run npm test for changes. Hosted auth/storage/isolation are unfinished; do not deploy the single-user loopback implementation unchanged. Do not introduce new frameworks, dependencies or paid model fallbacks without reviewing their need.
