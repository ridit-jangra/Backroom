/** Custom emoji name: also the stored form of a custom reaction. */
export const EMOJI_NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** Wire reaction code (no surrounding colons): `name` or `name::skin-tone-N`, N in 2-6. */
export const REACTION_CODE_RE = /^[a-z0-9_+-]{1,64}(::skin-tone-[2-6])?$/;
