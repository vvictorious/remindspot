import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ItemInput } from '../components/ItemInput';
import { ItemRow } from '../components/ItemRow';
import { useGeofenceScheduling } from '../hooks/useGeofenceScheduling';
import { useBackgroundDiscoveryInput } from '../hooks/useBackgroundDiscoveryInput';
import { useItemClassification } from '../hooks/useItemClassification';
import { useItems } from '../hooks/useItems';
import { usePlaceCandidates } from '../hooks/usePlaceCandidates';

const UNDO_DISMISS_MS = 5_000;

export function HomeScreen() {
  const {
    items,
    isLoading,
    storageError,
    addItem,
    updateItem,
    deleteItem,
    completeItem,
    undoItemCompletion,
    retryClassification,
    markClassificationPending,
    applyClassificationResult,
    markClassificationFailed,
  } = useItems();
  const [undoCompletion, setUndoCompletion] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeItems = items.filter((item) => item.completedAt === undefined);

  const dismissUndo = useCallback(() => {
    if (undoTimer.current !== null) {
      clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setUndoCompletion(null);
  }, []);

  useEffect(
    () => () => {
      if (undoTimer.current !== null) {
        clearTimeout(undoTimer.current);
      }
    },
    [],
  );

  const handleComplete = useCallback(
    (id: string) => {
      const item = items.find((candidate) => candidate.id === id);
      if (item === undefined || item.completedAt !== undefined) {
        return;
      }

      completeItem(id);
      setUndoCompletion({ id: item.id, text: item.text });
      if (undoTimer.current !== null) {
        clearTimeout(undoTimer.current);
      }
      undoTimer.current = setTimeout(() => {
        undoTimer.current = null;
        setUndoCompletion(null);
      }, UNDO_DISMISS_MS);
    },
    [completeItem, items],
  );

  const handleUndo = useCallback(() => {
    if (undoCompletion === null) {
      return;
    }

    undoItemCompletion(undoCompletion.id);
    dismissUndo();
  }, [dismissUndo, undoCompletion, undoItemCompletion]);

  useItemClassification({
    items,
    isLoadingItems: isLoading,
    markClassificationPending,
    applyClassificationResult,
    markClassificationFailed,
  });

  useBackgroundDiscoveryInput({
    isHydrated: !isLoading,
    items,
  });
  const placeCandidates = usePlaceCandidates({
    isLoadingItems: isLoading,
    items,
  });
  useGeofenceScheduling({
    isLoadingItems: isLoading,
    items,
    committedDiscovery: placeCandidates.committedDiscovery,
  });

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>THERE YOU GO</Text>
          <Text style={styles.title}>Don’t forget it.</Text>
          <Text style={styles.subtitle}>
            Keep a simple list for the next time you’re out.
          </Text>
          <ItemInput disabled={isLoading} onAdd={addItem} />
          {storageError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {storageError}
            </Text>
          ) : null}
        </View>

        <FlatList
          contentContainerStyle={[
            styles.listContent,
            activeItems.length === 0 && styles.emptyListContent,
          ]}
          data={activeItems}
          keyboardDismissMode={
            Platform.OS === 'ios' ? 'interactive' : 'on-drag'
          }
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            isLoading ? (
              <View style={styles.emptyState}>
                <ActivityIndicator color="#6d6b65" />
              </View>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>
                  {items.length > 0
                    ? 'You\'re all caught up!'
                    : 'Nothing to remember yet'}
                </Text>
                {items.length > 0 ? null : (
                  <Text style={styles.emptyText}>
                    Add something above and it’ll be here when you need it.
                  </Text>
                )}
              </View>
            )
          }
          renderItem={({ item }) => (
            <ItemRow
              item={item}
              onComplete={handleComplete}
              onDelete={deleteItem}
              onEdit={updateItem}
              onRetryClassification={retryClassification}
            />
          )}
        />
        {undoCompletion ? (
          <View style={styles.undoBanner}>
            <Text numberOfLines={1} style={styles.undoText}>
              Completed {undoCompletion.text}
            </Text>
            <Pressable
              accessibilityLabel={`Undo completing ${undoCompletion.text}`}
              accessibilityRole="button"
              onPress={handleUndo}
              style={({ pressed }) => [
                styles.undoButton,
                pressed && styles.undoButtonPressed,
              ]}
            >
              <Text style={styles.undoButtonText}>Undo</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f7f6f2',
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    paddingTop: 26,
    paddingHorizontal: 22,
  },
  eyebrow: {
    marginBottom: 10,
    color: '#76736a',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.8,
  },
  title: {
    color: '#1f1e1a',
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: -1.1,
  },
  subtitle: {
    maxWidth: 320,
    marginTop: 8,
    marginBottom: 24,
    color: '#6d6b65',
    fontSize: 16,
    lineHeight: 23,
  },
  error: {
    marginTop: 10,
    color: '#a3312c',
    fontSize: 13,
  },
  listContent: {
    flexGrow: 1,
    paddingTop: 24,
    paddingHorizontal: 22,
    paddingBottom: 28,
  },
  emptyListContent: {
    justifyContent: 'center',
  },
  emptyState: {
    paddingBottom: 64,
    alignItems: 'center',
  },
  emptyTitle: {
    color: '#3d3b36',
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyText: {
    maxWidth: 260,
    marginTop: 8,
    color: '#85827a',
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  undoBanner: {
    marginHorizontal: 22,
    marginBottom: 12,
    minHeight: 52,
    paddingLeft: 16,
    borderRadius: 16,
    backgroundColor: '#272621',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  undoText: {
    flex: 1,
    color: '#ffffff',
    fontSize: 15,
  },
  undoButton: {
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  undoButtonPressed: {
    opacity: 0.55,
  },
  undoButtonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
});
