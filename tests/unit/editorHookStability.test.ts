import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Editor from '../../components/Editor';
import { INITIAL_TRACKS } from '../../constants';

describe('Editor hook stability', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
    });

    it('can lose the selected track without changing the hook order', () => {
        flushSync(() => {
            root.render(React.createElement(Editor, { track: INITIAL_TRACKS[0] }));
        });

        expect(() => {
            flushSync(() => {
                root.render(React.createElement(Editor, { track: null }));
            });
        }).not.toThrow();

        expect(container.textContent).toContain('Ninguna Selección');
    });
});
