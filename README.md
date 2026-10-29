<div align="center">
  <img alt="Version" src="https://img.shields.io/github/v/tag/andreszs/comfyui-updater?label=version" />
  <img alt="Last Commit" src="https://img.shields.io/github/last-commit/andreszs/comfyui-updater" />
  <img alt="License" src="https://img.shields.io/github/license/andreszs/comfyui-updater" />
</div>
<br />

# ComfyUI Updater 🔄

> [!WARNING]
> **Active development:** This plugin is still under active development and is not yet recommended for production environments. Back up your ComfyUI installation before testing update operations.

ComfyUI Updater adds a native **Updates** section to ComfyUI Settings. It manages only ComfyUI Core and the official frontend package; it does not inspect, install, or update custom nodes.

## Features

- Separate **Update Core** and **Update Frontend** actions.
- Recommended **Update both** action for the tested Core/frontend version pair.
- Per-component **Up to date** and **Update needed** badges.
- Installed, latest, and sourced release-date metadata.
- Compatibility warning and frontend restore action when the installed pair does not match.
- Recovery branch, requirements snapshot, update log, and rollback before ComfyUI is relaunched.

## Install

Clone the repository into `ComfyUI/custom_nodes`:

```bash
git clone https://github.com/andreszs/comfyui-updater.git
```

Restart ComfyUI and hard-refresh the browser once. Open **Settings → Updates**.

## Update behavior

- **Update Core** checks out the latest stable ComfyUI tag and installs its non-frontend Python requirements while preserving the installed frontend.
- **Update Frontend** installs the frontend version paired with the latest stable Core while preserving the installed Core.
- **Update both** checks out the latest stable Core and installs its complete pinned requirements. This is the recommended path.
- **Restore compatible Frontend** reinstalls the version required by the currently installed Core.

Core changes require a Git-based ComfyUI installation with an `origin` remote and no tracked local changes. Frontend-only changes do not modify Git.

## Release dates

For Core, the plugin uses the published GitHub Release date when the tag has a release object. If the project publishes only a lightweight tag, the UI explicitly shows the tagged commit date instead. For Frontend, it uses the first non-yanked PyPI upload for the exact target package version. Values are cached after update checks; unavailable remote metadata never blocks an update.

## Recovery

Before a Core update, the worker creates a recovery branch and stores the previous requirements. If Git checkout or dependency installation fails, it restores the previous commit and requirements before relaunching ComfyUI.

Status, cache, and logs are stored under:

```text
ComfyUI/user/default/ComfyUI-Updater/updates
```

## Security

Every boot creates a random update token. Mutation requests require same-origin JSON, the token in a custom header, and one server-selected action. The browser cannot submit Git refs, filesystem paths, packages, or commands.

## Development

```bash
python -m unittest discover -s tests -v
npm test
npm run lint
```

## License

MIT
