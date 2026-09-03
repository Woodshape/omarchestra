---
status: accepted
---

# Install a persistent Omarchy companion plugin

Omarchestra follows Boomux's installation/runtime split: an explicitly authorized setup installs and enables one versioned Omarchestra-owned companion plugin through Omarchy's supported plugin mechanism, while Team Goals create only ephemeral projection sessions. Per-run repository-local plugin registration, an upstream Omarchy loader change, a fourth terminal dashboard, and per-goal QML installation or unload are rejected because they conflate product installation with runtime cleanup; normal Team Goal runs must not write Omarchy configuration, and exact cleanup applies to the projection and Team Goal resources rather than the durable product surface.
