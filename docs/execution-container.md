# Run a reduction in a Docker containment boundary

Repro Surgeon runs the configured command. A container can reduce which host files that command can reach or change. This recipe mounts the original project read-only and exposes one separate output directory as the only writable host path.

This is an extra operating boundary, not a built-in Repro Surgeon sandbox. Review the limitations below before using it with unfamiliar code.

## Prepare the paths and configuration

Install Docker with Linux-container support. The commands use the official `node:22.18.0-bookworm-slim` image and `repro-surgeon@0.2.1`.

Create `repro-surgeon.json` before starting the container. `repro-surgeon init` writes that file, so it cannot create it after the project is mounted read-only. Review the command and oracle in the configuration.

Set canonical source and output paths. The output must be a new directory that neither contains the source nor sits inside it. Use paths without commas because Docker's `--mount` syntax uses commas as separators.

```sh
export REPRO_SOURCE="$(cd /absolute/path/to/project && pwd -P)"
mkdir /absolute/path/to/repro-output || exit 1
export REPRO_OUTPUT="$(cd /absolute/path/to/repro-output && pwd -P)"

case "$REPRO_OUTPUT/" in
  "$REPRO_SOURCE/"*) echo "Output must be outside the source" >&2; exit 1 ;;
esac
case "$REPRO_SOURCE/" in
  "$REPRO_OUTPUT/"*) echo "Output must not contain the source" >&2; exit 1 ;;
esac
test ! -e "$REPRO_OUTPUT/run" || {
  echo "Choose an output directory without a run entry" >&2
  exit 1
}
```

If the configuration must remain outside the project, set an absolute `REPRO_CONFIG` path, add this mount to the reduction command:

```sh
--mount "type=bind,source=$REPRO_CONFIG,target=/config/repro-surgeon.json,readonly"
```

and add `--config /config/repro-surgeon.json` after `reduce /input`.

## Install and run inside the container

```sh
docker run --rm --init \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --network=bridge \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=2g \
  --env HOME=/tmp/home \
  --env TMPDIR=/tmp \
  --env npm_config_cache=/tmp/npm-cache \
  --env npm_config_update_notifier=false \
  --mount "type=bind,source=$REPRO_SOURCE,target=/input,readonly,bind-recursive=disabled" \
  --mount "type=bind,source=$REPRO_OUTPUT,target=/output" \
  --workdir /input \
  node:22.18.0-bookworm-slim \
  sh -eu -c '
    mkdir -p "$HOME"
    npm install --prefix /tmp/tool --ignore-scripts --no-audit --no-fund repro-surgeon@0.2.1
    exec /tmp/tool/node_modules/.bin/repro-surgeon \
      reduce /input --out /output/run
  '
```

The container root is read-only. `/tmp` is a disposable in-memory filesystem used for the installed CLI, dependency binaries, and execution workspaces. The explicit `exec` option is necessary because npm scripts and application builds commonly invoke executables from `node_modules/.bin`. On the host, only `REPRO_OUTPUT` is writable by the container.

The source bind uses `bind-recursive=disabled`. Nested mounts inside the source are not exposed to the container, avoiding a writable nested mount beneath an otherwise read-only bind. A project that relies on nested mounts needs a reviewed plain-directory copy instead. Docker documents the behavior of [read-only bind mounts and recursive bind options](https://docs.docker.com/engine/storage/bind-mounts/).

The normal Docker bridge network is intentional. Installing Repro Surgeon and uncached project dependencies requires registry access, and the configured command may also use the network. This recipe does not claim network isolation.

## Verify the exported reproduction

Run the standalone verifier in a fresh second container. The exported source is read-only and no writable host directory is mounted for this step.

```sh
export REPRO_EXPORT="$(cd "$REPRO_OUTPUT/run/repro" && pwd -P)"

docker run --rm --init \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --network=bridge \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777,size=2g \
  --env HOME=/tmp/home \
  --env TMPDIR=/tmp \
  --env npm_config_cache=/tmp/npm-cache \
  --env npm_config_update_notifier=false \
  --mount "type=bind,source=$REPRO_EXPORT,target=/repro,readonly,bind-recursive=disabled" \
  --workdir /repro \
  node:22.18.0-bookworm-slim \
  node .repro/verify.mjs
```

The verifier exits successfully when the configured failure is reproduced. Its fresh `npm ci` may need the same registry network access.

## Boundary and limitations

- `/input` remains readable. The configured command can read every mounted file, including `.git`, environment files, credentials, and files Repro Surgeon excludes from its snapshot. With network access, it can transmit what it reads. For unknown code, make a minimal reviewed source copy with no secrets before mounting it, and use stronger network or virtual-machine controls where needed.
- `/output` is deliberately writable and must be treated as untrusted. The command can create, replace, or delete anything beneath that directory. Inspect the generated reproduction before running or sharing it.
- The recipe mounts neither the host home directory nor the Docker socket. Adding either mount materially expands host access; mounting the Docker socket effectively grants control of the Docker daemon.
- Dropping all Linux capabilities, setting `no-new-privileges`, using a read-only container root, and running as the invoking user reduce authority inside the container. They do not eliminate container-runtime or kernel risk. Docker describes these controls in the [`docker run` reference](https://docs.docker.com/reference/cli/docker/container/run/).
- Absolute paths and `../` traversal can still move around the container filesystem. They cannot make the read-only `/input` bind writable. They can reach `/output`, because that is the explicit handoff boundary.
- Do not use `--privileged`, host PID/network namespaces, host devices, the Docker socket, or broad host-directory mounts with this recipe.
