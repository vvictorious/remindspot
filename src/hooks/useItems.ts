import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ItemClassificationResult } from '../models/Classification';
import {
  applyClassificationResult as applyResult,
  completeItem as completeStoredItem,
  createItem,
  deleteItem as removeItem,
  markClassificationFailed as markFailed,
  markClassificationPending as markPending,
  retryItemClassification,
  undoItemCompletion as undoStoredItemCompletion,
  updateItemText,
  type ClassificationAttemptSnapshot,
  type ClassificationFailure,
} from '../models/item-transitions';
import type { Item } from '../models/Item';
import {
  ITEMS_STORAGE_KEY,
  parseStoredItems,
  serializeItems,
} from '../storage/items';

function createItemId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useItems() {
  const [items, setItems] = useState<Item[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  const skipNextPersistence = useRef(true);

  useEffect(() => {
    let isActive = true;

    async function loadItems() {
      try {
        const storedValue = await AsyncStorage.getItem(ITEMS_STORAGE_KEY);
        if (!isActive || storedValue === null) {
          return;
        }

        setItems(parseStoredItems(storedValue));
      } catch {
        if (isActive) {
          setStorageError('Saved items could not be loaded.');
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void loadItems();

    return () => {
      isActive = false;
    };
  }, []);

  const persist = useCallback((nextItems: Item[]) => {
    writeQueue.current = writeQueue.current
      .catch(() => undefined)
      .then(() =>
        AsyncStorage.setItem(ITEMS_STORAGE_KEY, serializeItems(nextItems)),
      )
      .then(() => setStorageError(null))
      .catch(() => {
        setStorageError('Changes could not be saved on this device.');
      });
  }, []);

  useEffect(() => {
    if (isLoading) {
      return;
    }
    if (skipNextPersistence.current) {
      skipNextPersistence.current = false;
      return;
    }

    persist(items);
  }, [isLoading, persist, items]);

  const addItem = useCallback((text: string) => {
    const item = createItem(createItemId(), text, new Date().toISOString());
    if (item === null) {
      return;
    }

    setItems((currentItems) => [item, ...currentItems]);
  }, []);

  const updateItem = useCallback((id: string, text: string) => {
    setItems((currentItems) =>
      updateItemText(currentItems, id, text, new Date().toISOString()),
    );
  }, []);

  const deleteItem = useCallback((id: string) => {
    setItems((currentItems) => removeItem(currentItems, id));
  }, []);

  const completeItem = useCallback((id: string) => {
    setItems((currentItems) =>
      completeStoredItem(currentItems, id, new Date().toISOString()),
    );
  }, []);

  const undoItemCompletion = useCallback((id: string) => {
    setItems((currentItems) => undoStoredItemCompletion(currentItems, id));
  }, []);

  const retryClassification = useCallback((id: string) => {
    setItems((currentItems) => retryItemClassification(currentItems, id));
  }, []);

  const markClassificationPending = useCallback(
    (
      id: string,
      attempt: ClassificationAttemptSnapshot,
      nextAttemptAt: string | null,
    ) => {
      setItems((currentItems) =>
        markPending(currentItems, id, attempt, nextAttemptAt),
      );
    },
    [],
  );

  const applyClassificationResult = useCallback(
    (
      id: string,
      attempt: ClassificationAttemptSnapshot,
      result: ItemClassificationResult,
    ) => {
      setItems((currentItems) =>
        applyResult(currentItems, id, attempt, result),
      );
    },
    [],
  );

  const markClassificationFailed = useCallback(
    (
      id: string,
      attempt: ClassificationAttemptSnapshot,
      failure: ClassificationFailure,
    ) => {
      setItems((currentItems) =>
        markFailed(currentItems, id, attempt, failure),
      );
    },
    [],
  );

  return {
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
  };
}
