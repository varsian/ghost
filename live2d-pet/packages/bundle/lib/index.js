/**
 * @local/dsh-live2d-bundle — the bundle layer.
 *
 * A bundle package carries no runtime plugin of its own: app-boot reads
 * `package.json.dsh.bundle.patch` and composes `cordis.patch.yml` into the
 * profile. The host plugin is inserted by name (`@local/dsh-live2d`), so this
 * module intentionally exports nothing.
 */
export {}
