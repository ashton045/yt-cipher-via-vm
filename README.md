# yt-cipher-via-vm
A rewritten http service of [kikkia/yt-cipher](https://github.com/kikkia/yt-cipher) that doesn't rely on AST parsing
instead it downloads the youtube player script and uses a regex to get the internal `URL` builder function (the one that calls `set("alr","yes")`), and rewrites its assignment to also expose it as `window.__solve_url`
thhen it runs the full player inside a jsdom VM and calls that exposed function to decipher the `s` and `n` parameters.
