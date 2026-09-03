/**
 * The composer's [image #1] chips survive the window changing shape.
 *
 * The chips are drawn by a mirror of the prompt laid over the textarea, and
 * the mirror takes itself off rather than stand on the wrong words if it and
 * the textarea disagree on how many lines the prompt is. A box fitted only
 * when the prompt changes disagrees after every resize — it stays as tall as
 * the narrower window left it, and a textarea taller than its own text
 * reports its height as the text's — so every chip came off the prompt and
 * stayed off until the next keystroke.
 *
 * This drives the real app: attaches a picture, writes a prompt long enough
 * to wrap, then narrows and widens the viewport, asserting the chips are
 * still there and the two still agree.
 *
 * Needs the app built (`bun run build:web && bun run build:main`):
 *   bun run chips-test
 */

const PROMPT =
  "Also could you make this one such that it shows you this screen so that " +
  "you can actually compare instead of just going off of what you heard " +
  "from yourself while talking uk?";

let failed = 0;

function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

/** Everything the assertions look at, measured in one pass. */
const MEASURE = `(() => {
  const area = document.querySelector('.composer-box textarea');
  const mirror = document.querySelector('.composer-mirror');
  const inner = document.querySelector('.composer-mirror-text');
  const chip = document.querySelector('.marker-chip');
  return {
    chips: document.querySelectorAll('.marker-chip').length,
    visible: chip ? getComputedStyle(chip).visibility : null,
    off: mirror ? mirror.classList.contains('off') : null,
    innerH: inner ? inner.offsetHeight : null,
    scrollH: area ? area.scrollHeight : null,
    width: area ? area.clientWidth : null,
  };
})()`;

/** A chip standing on its word, with the box fitted to the words. */
function sound(state) {
  return (
    state.chips === 1 &&
    state.visible === "visible" &&
    state.off === false &&
    Math.abs(state.innerH - state.scrollH) <= 2
  );
}

async function resize(page, width) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width,
    height: 850,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await page.wait(700);
  return page.eval(MEASURE);
}

export default async function (page) {
  // the window starts wide; go narrow first so the prompt wraps to more
  // lines than it will need once it is widened again
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 850,
    deviceScaleFactor: 0,
    mobile: false,
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.eval(`Boolean(document.querySelector('.composer-box textarea'))`)) break;
    await page.wait(250);
  }

  // a picture into the composer, the way a paste puts one there, and a
  // prompt long enough to wrap at this width
  await page.eval(`(async () => {
    const area = document.querySelector('.composer-box textarea');
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 30;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#c33';
    ctx.fillRect(0, 0, 40, 30);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    area.focus();
    area.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200));
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, area.value + ${JSON.stringify(PROMPT)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  })()`);

  const narrow = await page.eval(MEASURE);
  check("a pasted picture is a chip in the prompt", sound(narrow), narrow);

  const narrower = await resize(page, 880);
  check("the chips stand through a narrower window", sound(narrower), narrower);

  const wide = await resize(page, 1400);
  check("the chips stand through a wider window", sound(wide), wide);
  // the point of the wide pass: the prompt really does need fewer lines
  // there, which is the case that used to leave the box unfitted
  check(
    "the wider window fitted the box back down",
    wide.innerH < narrower.innerH && wide.width > narrower.width,
    { narrower, wide },
  );

  const back = await resize(page, 900);
  check("and back again", sound(back), back);

  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  if (failed > 0) throw new Error(`${failed} check(s) failed`);
}
