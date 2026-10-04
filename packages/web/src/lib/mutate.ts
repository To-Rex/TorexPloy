/** Mutations with consistent feedback: success toast, error toast, precise invalidation. */
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useToast } from '../components/Toast.tsx';
import { ApiError } from './api.ts';

export interface ActionOptions<TResult> {
  success?: string | ((result: TResult) => string | null) | null;
  invalidate?: QueryKey[];
  onSuccess?: (result: TResult) => void;
  /** Leave validation errors for the form to render inline instead of toasting them. */
  inlineValidation?: boolean;
}

export function useAction<TArgs = void, TResult = unknown>(fn: (args: TArgs) => Promise<TResult>, options: ActionOptions<TResult> = {}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation<TResult, unknown, TArgs>({
    mutationFn: fn,
    onSuccess: (result) => {
      for (const key of options.invalidate ?? []) void client.invalidateQueries({ queryKey: key });
      const message = typeof options.success === 'function' ? options.success(result) : options.success;
      if (message) toast.success(message);
      options.onSuccess?.(result);
    },
    onError: (error) => {
      if (options.inlineValidation && error instanceof ApiError && error.code === 'validation_failed' && error.issues.length > 0) return;
      toast.error(error);
    },
  });
}
