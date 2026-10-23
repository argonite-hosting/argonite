import { Markdown } from '../components/Markdown';
import { SITE } from '../config';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';

interface Example {
  id: string;
  title: string;
  body: string;
  code: string;
  preview?: boolean;
}

const IMG = `${SITE.url}/apple-touch-icon.png`;

// Keep this in step with the rules in lib/markdown.ts.
function examples(): Example[] {
  return [
    {
      id: 'text',
      title: t('Text'),
      body: t('Bold, italic, strikethrough, inline code, highlights, keyboard keys, subscript and superscript.'),
      code: '**Bold**, *italic*, ~~old~~ and `code`.\nPress <kbd>F3</kbd> + <kbd>B</kbd>. <mark>New in 2.0</mark>, H<sub>2</sub>O, 10<sup>3</sup>.',
    },
    {
      id: 'headings',
      title: t('Headings'),
      body: t('Use ## to ######. A single # is shown one level down, because the project name is the page’s main heading. Every heading can be linked to.'),
      code: '## Features\n### Installation',
    },
    {
      id: 'links',
      title: t('Links'),
      body: t('https and mailto links, and links to a heading on the same page. Links to other sites open in a new tab.'),
      code: '[Wiki](https://example.com/wiki) · [Jump to Installation](#installation)',
    },
    {
      id: 'images',
      title: t('Images'),
      body: t('Images must use an https link. Use align to centre or float them, and width or height to size them.'),
      code: `![Logo](${IMG})\n\n<p align="center"><img src="${IMG}" width="96" alt="Centred logo"></p>`,
    },
    {
      id: 'dark-light',
      title: t('Separate dark and light images'),
      body: t('Shows a different image depending on the reader’s theme. Each source needs one https image and the exact media value shown.'),
      code: `<picture>\n  <source media="(prefers-color-scheme: dark)" srcset="https://example.com/banner-dark.png">\n  <img src="https://example.com/banner-light.png" alt="Banner">\n</picture>`,
      preview: false,
    },
    {
      id: 'lists',
      title: t('Lists and task lists'),
      body: t('Bulleted, numbered and checkbox lists. Checkboxes are shown but can’t be ticked by readers.'),
      code: '- Fabric\n- NeoForge\n\n1. Download\n2. Install\n\n- [x] 1.21 support\n- [ ] Config screen',
    },
    {
      id: 'tables',
      title: t('Tables'),
      body: t('Use colons in the divider row to align a column.'),
      code: '| Loader | Supported |\n|:--|:--:|\n| Fabric | Yes |\n| Forge | No |',
    },
    {
      id: 'code',
      title: t('Code blocks'),
      body: t('Wrap code in three backticks.'),
      code: '```\n/give @p diamond 64\n```',
    },
    {
      id: 'quotes',
      title: t('Quotes'),
      body: t('Start a line with > to quote it.'),
      code: '> Requires Fabric API.',
    },
    {
      id: 'collapsible',
      title: t('Collapsible sections'),
      body: t('Handy for long changelogs, FAQs and screenshots.'),
      code: '<details>\n<summary>Show the full list</summary>\n\n- First change\n- Second change\n\n</details>',
    },
    {
      id: 'progress',
      title: t('Progress bars'),
      body: t('For roadmaps and completion status. Only value, min and max are kept.'),
      code: 'Port to 1.21: <progress value="70" max="100"></progress>',
    },
    {
      id: 'youtube',
      title: t('YouTube videos'),
      body: t('Paste a YouTube embed link in an iframe. Videos play from youtube-nocookie.com in a locked-down player. Add ?start= with a number of seconds to start partway.'),
      code: '<iframe src="https://www.youtube.com/embed/VIDEO_ID?start=90"></iframe>',
      preview: false,
    },
    {
      id: 'media',
      title: t('Video and audio files'),
      body: t('Files must use an https link. Players always show controls and never start on their own. loop and muted are allowed.'),
      code: '<video src="https://example.com/showcase.mp4" loop muted></video>\n<audio src="https://example.com/theme.ogg"></audio>',
      preview: false,
    },
  ];
}

export default function Formatting() {
  useHead(t('Formatting guide'), t('What you can use in project descriptions, changelogs and server descriptions on {site}.', { site: SITE.name }));
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('Formatting guide')}</h1>
          <p class="page-sub">{t('Project descriptions, version changelogs and server descriptions use Markdown, plus the HTML tags listed here. Anything else is removed when the page is shown.')}</p>
        </div>
      </div>
      <div class="stack-lg">
        {examples().map((ex) => (
          <section key={ex.id} id={ex.id} class="card card-pad format-example">
            <h2>{ex.title}</h2>
            <p class="muted">{ex.body}</p>
            <div class={`format-grid${ex.preview === false ? ' format-grid-single' : ''}`}>
              <pre class="format-code">
                <code>{ex.code}</code>
              </pre>
              {ex.preview !== false && (
                <div class="format-preview">
                  <Markdown source={ex.code} />
                </div>
              )}
            </div>
          </section>
        ))}
        <section class="card card-pad prose">
          <h2>{t('What gets removed')}</h2>
          <ul>
            <li>{t('Scripts, forms, buttons and text boxes.')}</li>
            <li>{t('Styling with style or class, so a page can’t imitate the site’s own buttons or badges.')}</li>
            <li>{t('Embeds from sites other than YouTube, and SVG.')}</li>
            <li>{t('Images, videos and links that use plain http.')}</li>
            <li>{t('Links to sites on malware or phishing lists. They can’t be saved, and a link whose site is added to a list later is disabled.')}</li>
          </ul>
          <p>{t('Comments are plain text. Links starting with https become clickable.')}</p>
        </section>
      </div>
    </div>
  );
}
