import * as assert from 'assert';
import { sanitizeHtml } from '../src/orchestrator/sanitizer';

// Unit tests for the Chat_View's owned HTML sanitizer injection cases
// (Req 12.5, 12.6, 20.5). These assert the sanitizer removes script elements,
// style elements, `on*` event-handler attributes, and `javascript:`-scheme
// attribute values from rendered markup while preserving all other markup,
// asserted in isolation without a running VS Code host.

describe('sanitizeHtml injection cases', () => {
  describe('script elements', () => {
    it('removes a <script> element and its content while preserving surrounding markup', () => {
      const input = '<p>before</p><script>alert(1)</script><p>after</p>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<script'), false);
      assert.strictEqual(output.includes('alert(1)'), false);
      assert.strictEqual(output, '<p>before</p><p>after</p>');
    });

    it('removes a <script> element carrying attributes', () => {
      const input = '<div>keep</div><script src="evil.js" type="text/javascript">x=1</script><span>ok</span>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<script'), false);
      assert.strictEqual(output.includes('evil.js'), false);
      assert.strictEqual(output.includes('x=1'), false);
      assert.strictEqual(output.includes('<div>keep</div>'), true);
      assert.strictEqual(output.includes('<span>ok</span>'), true);
    });

    it('removes an unterminated <script> open tag', () => {
      const input = '<p>hi</p><script src="evil.js">';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<script'), false);
      assert.strictEqual(output.includes('evil.js'), false);
      assert.strictEqual(output.includes('<p>hi</p>'), true);
    });
  });

  describe('style elements', () => {
    it('removes a <style> element and its content while preserving surrounding markup', () => {
      const input = '<p>before</p><style>body { display: none }</style><p>after</p>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<style'), false);
      assert.strictEqual(output.includes('display: none'), false);
      assert.strictEqual(output, '<p>before</p><p>after</p>');
    });

    it('removes a <style> element carrying attributes', () => {
      const input = '<h1>title</h1><style media="all">a{}</style><h2>sub</h2>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<style'), false);
      assert.strictEqual(output.includes('<h1>title</h1>'), true);
      assert.strictEqual(output.includes('<h2>sub</h2>'), true);
    });
  });

  describe('on* event-handler attributes', () => {
    it('removes an onclick attribute while preserving the element and its other attributes', () => {
      const input = '<button id="go" onclick="steal()">Click</button>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('onclick'), false);
      assert.strictEqual(output.includes('steal()'), false);
      assert.strictEqual(output.includes('id="go"'), true);
      assert.strictEqual(output.includes('>Click</button>'), true);
    });

    it('removes an event handler regardless of case', () => {
      const input = '<img src="pic.png" OnError="hack()">';
      const output = sanitizeHtml(input);
      assert.strictEqual(/onerror/i.test(output), false);
      assert.strictEqual(output.includes('hack()'), false);
      assert.strictEqual(output.includes('src="pic.png"'), true);
    });

    it('removes multiple event-handler attributes while keeping benign ones', () => {
      const input = '<a href="/page" onmouseover="a()" title="t" onfocus="b()">link</a>';
      const output = sanitizeHtml(input);
      assert.strictEqual(/onmouseover/i.test(output), false);
      assert.strictEqual(/onfocus/i.test(output), false);
      assert.strictEqual(output.includes('href="/page"'), true);
      assert.strictEqual(output.includes('title="t"'), true);
      assert.strictEqual(output.includes('>link</a>'), true);
    });
  });

  describe('javascript: URI schemes', () => {
    it('removes an href whose value uses a javascript: scheme while preserving the element', () => {
      const input = '<a href="javascript:evil()">click</a>';
      const output = sanitizeHtml(input);
      assert.strictEqual(/javascript:/i.test(output), false);
      assert.strictEqual(output.includes('>click</a>'), true);
    });

    it('removes a javascript: scheme regardless of case and preserves benign attributes', () => {
      const input = '<a class="c" href="JavaScript:doBad()">go</a>';
      const output = sanitizeHtml(input);
      assert.strictEqual(/javascript:/i.test(output), false);
      assert.strictEqual(output.includes('class="c"'), true);
      assert.strictEqual(output.includes('>go</a>'), true);
    });

    it('preserves an ordinary http URI value', () => {
      const input = '<a href="https://example.com">safe</a>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('href="https://example.com"'), true);
    });
  });

  describe('preserving unrelated markup', () => {
    it('leaves plain markup with no injection unchanged', () => {
      const input = '<p>Hello <strong>world</strong> and <em>more</em>.</p>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output, input);
    });

    it('removes only the dangerous constructs from a mixed document', () => {
      const input =
        '<h1>Title</h1>' +
        '<p onclick="x()">para</p>' +
        '<script>bad()</script>' +
        '<a href="javascript:y()">bad link</a>' +
        '<style>.z{}</style>' +
        '<ul><li>item</li></ul>';
      const output = sanitizeHtml(input);
      assert.strictEqual(output.includes('<script'), false);
      assert.strictEqual(output.includes('<style'), false);
      assert.strictEqual(output.includes('onclick'), false);
      assert.strictEqual(/javascript:/i.test(output), false);
      assert.strictEqual(output.includes('<h1>Title</h1>'), true);
      assert.strictEqual(output.includes('<ul><li>item</li></ul>'), true);
      assert.strictEqual(output.includes('>para</p>'), true);
      assert.strictEqual(output.includes('>bad link</a>'), true);
    });
  });
});
