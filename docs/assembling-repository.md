# Assembling the Repository

Assembling the APT repository additionally requires `reprepro` and the GPG
secret key matching `signing_key` in `repository.toml` (insert the smartcard
before running):

```sh
just repo
```

The repository is assembled under `repo/` and can be published with any
static file server. On clients:

```sh
sudo install -Dm644 repo/krysztal-archive-keyring.pgp /usr/share/keyrings/krysztal-archive-keyring.pgp
echo "deb [signed-by=/usr/share/keyrings/krysztal-archive-keyring.pgp] <url> trixie main" \
  | sudo tee /etc/apt/sources.list.d/krysztal.list
```
