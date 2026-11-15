Frozen copy of `packaging/` as committed before the first release (version 0.0.0, all-zero hashes).
The packaging script tests copy this folder, not the live `packaging/`, so they keep working after
`scripts/packaging-bump.mjs` writes a real release into `packaging/`. Do not update it.
