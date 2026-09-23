# Raw reader draws

`draws.tar.gz` retains every original prompt, response, receipt and stderr file byte for byte. `draws-archive.json` pins each member and the archive itself. No results were rescored or removed.

Extract beside this file before inspecting individual draws or rerunning the scorer:

```sh
tar -xzf draws.tar.gz
```

The extracted `draws/` directory is ignored to keep the PR file inventory bounded. The source machine retains the original extracted files.
