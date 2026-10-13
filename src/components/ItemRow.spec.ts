import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import {
  DESTINATION_TAXONOMY_VERSION,
  type ItemClassification,
  type ItemClassificationResult,
} from '../models/Classification';
import type { Item } from '../models/Item';
import { ItemRow } from './ItemRow';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Animated: {
    Value: class {
      setValue() {}
    },
    View: 'AnimatedView',
    spring: () => ({ start: () => undefined }),
  },
  PanResponder: {
    create: () => ({ panHandlers: { onResponderMove: () => undefined } }),
  },
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
}));

const source = {
  sourceRevision: 1,
  sourceText: 'Milk',
  taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
};

function makeItem(classification: ItemClassification): Item {
  return {
    id: 'item-1',
    text: 'Milk',
    createdAt: '2026-10-09T10:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
    revision: 1,
    classification,
  };
}

function current(result: ItemClassificationResult): ItemClassification {
  return { status: 'current', ...source, result };
}

function renderRow(
  item: Item,
  overrides: Partial<React.ComponentProps<typeof ItemRow>> = {},
) {
  const props: React.ComponentProps<typeof ItemRow> = {
    item,
    onComplete: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onRetryClassification: vi.fn(),
    ...overrides,
  };
  let renderer: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(React.createElement(ItemRow, props));
  });
  return { props, renderer: renderer! };
}

function findTextInput(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(({ props }) => props.autoFocus === true);
}

function findTextInputs(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(({ props }) => props.autoFocus === true);
}

describe('ItemRow classification status', () => {
  it.each([
    {
      name: 'unclassified',
      classification: {
        status: 'unclassified',
        taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
      } satisfies ItemClassification,
    },
    {
      name: 'pending',
      classification: {
        status: 'pending',
        ...source,
        attemptCount: 1,
        nextAttemptAt: null,
      } satisfies ItemClassification,
    },
  ])('shows a loading indicator while $name', ({ classification }) => {
    const { renderer } = renderRow(makeItem(classification));

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Classifying Milk' })
        .props.accessibilityRole,
    ).toBe('progressbar');
  });

  it.each<ItemClassificationResult>([
    {
      outcome: 'classified',
      categories: ['grocery-store'],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'no-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
    {
      outcome: 'unsupported-destination',
      categories: [],
      taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
    },
  ])('shows no status action for $outcome', (result) => {
    const { renderer } = renderRow(makeItem(current(result)));
    const statusActions = renderer.root.findAll(
      ({ props }) =>
        typeof props.accessibilityLabel === 'string' &&
        (props.accessibilityLabel.startsWith('Classifying') ||
          props.accessibilityLabel.startsWith('Clarify') ||
          props.accessibilityLabel.startsWith('Retry classification')),
    );

    expect(statusActions).toHaveLength(0);
  });

  it('shows the clarification question and edits from its indicator', () => {
    const onEdit = vi.fn();
    const question = 'Which kind of milk?';
    const { renderer } = renderRow(
      makeItem(
        current({
          outcome: 'needs-clarification',
          categories: [],
          clarificationQuestion: question,
          taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
        }),
      ),
      { onEdit },
    );

    expect(renderer.root.findByProps({ children: question })).toBeDefined();

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Clarify Milk' })
        .props.onPress();
    });
    const input = findTextInput(renderer);
    act(() => input.props.onChangeText('Oat milk'));
    act(() => findTextInput(renderer).props.onSubmitEditing());

    expect(onEdit).toHaveBeenCalledWith('item-1', 'Oat milk');
  });

  it('shows a warning and explicitly retries a failed item', () => {
    const onRetryClassification = vi.fn();
    const { renderer } = renderRow(
      makeItem({
        status: 'failed',
        ...source,
        attemptCount: 3,
        nextAttemptAt: null,
        retryable: false,
        failureKind: 'invalid-response',
      }),
      { onRetryClassification },
    );

    act(() => {
      renderer.root
        .findByProps({
          accessibilityLabel: 'Retry classification for Milk',
        })
        .props.onPress();
    });

    expect(onRetryClassification).toHaveBeenCalledWith('item-1');
    expect(findTextInputs(renderer)).toHaveLength(0);
  });
});

describe('ItemRow existing interactions', () => {
  const classification = current({
    outcome: 'no-destination',
    categories: [],
    taxonomyVersion: DESTINATION_TAXONOMY_VERSION,
  });

  it('completes from its control without starting an edit', () => {
    const onComplete = vi.fn();
    const onEdit = vi.fn();
    const { renderer } = renderRow(makeItem(classification), {
      onComplete,
      onEdit,
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Complete Milk' })
        .props.onPress();
    });

    expect(onComplete).toHaveBeenCalledWith('item-1');
    expect(onEdit).not.toHaveBeenCalled();
    expect(findTextInputs(renderer)).toHaveLength(0);
  });

  it('hides the completion control while editing', () => {
    const { renderer } = renderRow(makeItem(classification));

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Edit Milk' })
        .props.onPress();
    });

    expect(
      renderer.root.findAll(
        ({ props }) => props.accessibilityLabel === 'Complete Milk',
      ),
    ).toHaveLength(0);
    expect(findTextInputs(renderer)).toHaveLength(1);
  });

  it('continues to support editing and deleting', () => {
    const onDelete = vi.fn();
    const onEdit = vi.fn();
    const { renderer } = renderRow(makeItem(classification), {
      onDelete,
      onEdit,
    });

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Edit Milk' })
        .props.onPress();
    });
    const input = findTextInput(renderer);
    act(() => input.props.onChangeText('Oat milk'));
    act(() => findTextInput(renderer).props.onSubmitEditing());
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Delete Milk' })
        .props.onPress();
    });

    expect(onEdit).toHaveBeenCalledWith('item-1', 'Oat milk');
    expect(onDelete).toHaveBeenCalledWith('item-1');
  });
});
