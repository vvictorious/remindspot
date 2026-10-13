import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { Item } from '../models/Item';

const DELETE_ACTION_WIDTH = 88;

type ItemRowProps = {
  item: Item;
  onComplete: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onRetryClassification: (id: string) => void;
};

export function ItemRow({
  item,
  onComplete,
  onDelete,
  onEdit,
  onRetryClassification,
}: ItemRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [translation] = useState(() => new Animated.Value(0));
  const hasCommitted = useRef(false);

  const settleSwipe = useCallback(
    (toValue: number) => {
      Animated.spring(translation, {
        toValue,
        useNativeDriver: true,
        damping: 22,
        stiffness: 230,
        mass: 0.8,
      }).start();
    },
    [translation],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gestureState) =>
          !isEditing &&
          gestureState.dx < -6 &&
          Math.abs(gestureState.dx) > Math.abs(gestureState.dy),
        onPanResponderMove: (_, gestureState) => {
          translation.setValue(
            Math.max(-DELETE_ACTION_WIDTH, Math.min(0, gestureState.dx)),
          );
        },
        onPanResponderRelease: (_, gestureState) => {
          const shouldReveal =
            gestureState.dx < -DELETE_ACTION_WIDTH / 2 ||
            gestureState.vx < -0.5;
          settleSwipe(shouldReveal ? -DELETE_ACTION_WIDTH : 0);
        },
        onPanResponderTerminate: () => settleSwipe(0),
      }),
    [isEditing, settleSwipe, translation],
  );

  const startEditing = () => {
    settleSwipe(0);
    hasCommitted.current = false;
    setDraft(item.text);
    setIsEditing(true);
  };

  const commitEdit = () => {
    if (hasCommitted.current) {
      return;
    }

    hasCommitted.current = true;
    setIsEditing(false);
    onEdit(item.id, draft);
  };

  const classification = item.classification;
  const isLoadingClassification =
    classification.status === 'unclassified' ||
    classification.status === 'pending';
  const clarification =
    classification.status === 'current' &&
    classification.result.outcome === 'needs-clarification'
      ? classification.result.clarificationQuestion
      : null;
  const hasFailedClassification = classification.status === 'failed';

  return (
    <View style={styles.swipeContainer}>
      <Pressable
        accessibilityLabel={`Delete ${item.text}`}
        accessibilityRole="button"
        onPress={() => onDelete(item.id)}
        style={({ pressed }) => [
          styles.deleteAction,
          pressed && styles.deleteActionPressed,
        ]}
      >
        <Text style={styles.deleteText}>Delete</Text>
      </Pressable>

      <Animated.View
        style={[styles.item, { transform: [{ translateX: translation }] }]}
        {...panResponder.panHandlers}
      >
        {isEditing ? (
          <TextInput
            accessibilityLabel={`Edit ${item.text}`}
            autoFocus
            onBlur={commitEdit}
            onChangeText={setDraft}
            onSubmitEditing={commitEdit}
            returnKeyType="done"
            selectTextOnFocus
            selectionColor="#272621"
            style={styles.editInput}
            value={draft}
          />
        ) : (
          <View style={styles.itemContent}>
            <Pressable
              accessibilityLabel={`Complete ${item.text}`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onComplete(item.id)}
              style={({ pressed }) => [
                styles.completeButton,
                pressed && styles.statusPressed,
              ]}
            >
              <View style={styles.completeMark} />
            </Pressable>
            <Pressable
              accessibilityHint="Double tap to edit. Swipe left for delete."
              accessibilityLabel={`Edit ${item.text}`}
              accessibilityRole="button"
              onPress={startEditing}
              style={({ pressed }) => [
                styles.itemTextButton,
                pressed && styles.itemPressed,
              ]}
            >
              <Text style={styles.itemText}>{item.text}</Text>
              {clarification ? (
                <Text style={styles.clarificationQuestion}>
                  {clarification}
                </Text>
              ) : null}
            </Pressable>

            {isLoadingClassification ? (
              <View
                accessible
                accessibilityLabel={`Classifying ${item.text}`}
                accessibilityRole="progressbar"
                style={styles.statusIndicator}
              >
                <ActivityIndicator color="#85827a" size="small" />
              </View>
            ) : null}

            {clarification ? (
              <Pressable
                accessibilityHint={clarification}
                accessibilityLabel={`Clarify ${item.text}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={startEditing}
                style={({ pressed }) => [
                  styles.clarificationIndicator,
                  pressed && styles.statusPressed,
                ]}
              >
                <Text style={styles.clarificationIndicatorText}>?</Text>
              </Pressable>
            ) : null}

            {hasFailedClassification ? (
              <Pressable
                accessibilityLabel={`Retry classification for ${item.text}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onRetryClassification(item.id)}
                style={({ pressed }) => [
                  styles.retryButton,
                  pressed && styles.statusPressed,
                ]}
              >
                <Text style={styles.warningText}>!</Text>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  swipeContainer: {
    minHeight: 64,
    marginBottom: 10,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#d94b45',
  },
  deleteAction: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: DELETE_ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#d94b45',
  },
  deleteActionPressed: {
    backgroundColor: '#bd3934',
  },
  deleteText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  item: {
    minHeight: 64,
    justifyContent: 'center',
    borderColor: '#e4e2dc',
    borderRadius: 16,
    borderWidth: 1,
    backgroundColor: '#ffffff',
  },
  itemContent: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  completeButton: {
    paddingLeft: 16,
    paddingRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completeMark: {
    width: 22,
    height: 22,
    borderColor: '#aaa79f',
    borderRadius: 11,
    borderWidth: 1.5,
  },
  itemTextButton: {
    flex: 1,
    minHeight: 62,
    paddingVertical: 10,
    paddingRight: 10,
    justifyContent: 'center',
  },
  itemPressed: {
    backgroundColor: '#f7f6f2',
  },
  itemText: {
    color: '#272621',
    fontSize: 17,
    lineHeight: 23,
  },
  clarificationQuestion: {
    marginTop: 3,
    color: '#76736a',
    fontSize: 13,
    lineHeight: 18,
  },
  statusIndicator: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clarificationIndicator: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clarificationIndicatorText: {
    width: 22,
    height: 22,
    borderColor: '#aaa79f',
    borderRadius: 11,
    borderWidth: 1,
    color: '#6d6b65',
    fontSize: 14,
    fontWeight: '700',
    lineHeight: 20,
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  warningText: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: '#a3312c',
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '800',
    lineHeight: 18,
    textAlign: 'center',
  },
  retryText: {
    color: '#8b2d28',
    fontSize: 13,
    fontWeight: '600',
  },
  statusPressed: {
    opacity: 0.55,
  },
  editInput: {
    minHeight: 62,
    paddingHorizontal: 18,
    color: '#272621',
    fontSize: 17,
  },
});
