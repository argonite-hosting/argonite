<p><img src="brand/wordmark-on-light.svg" alt="Argonite" height="48"></p>

A Minecraft content repository where every download is verified. Mods, plugins, resource packs, shaders, data packs and modpacks are published to the author's own GitHub releases; Argonite scans each file, signs its fingerprint, and the player's browser checks that fingerprint before saving anything.

## What's included

- **Publishing**: versions with several files each, one jar listed for several loaders, featured versions, dependencies and changelogs. Releases stay drafts on GitHub until every file passes its scan.
- **Automation**: auto-publish from GitHub releases, and scoped API tokens for publishing from CI.
- **Modpacks**: every file a pack installs is checked, with a public contents list.
- **Teams**: project members and organisations with per-member permissions.
- **Community**: comments, collections and profile links.
- **Players**: follows, notifications, RSS and Atom feeds, Minecraft server listings with live status, and the interface in nine languages.
- **Creators**: download and page-view analytics without tracking cookies, README badges, and a public JSON API for launchers.

## Formatting descriptions

Project descriptions, changelogs and server descriptions use Markdown plus a set of safe HTML tags, including collapsible sections, centred images, dark and light banners and YouTube embeds. The [formatting guide](https://argonite.org/help/formatting) lists everything that's allowed.

## Contributing

Interface translations live in [`web/src/locales`](web/src/locales), one JSON file per language mapping the English text to its translation. `npm run i18n` lists any strings a language is missing.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Argonite is licensed under the [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`). If you run a modified version as a public service, you must make your modified source available to its users; the site's footer links to the source for this reason.
