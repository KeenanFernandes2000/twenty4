// (app)/feed/[montageId]/comments — the comments screen/sheet (M8 §6 3.3). Lists
// active, block-filtered comments (keyset paginated, ASC), an optimistic composer
// (≤500 chars client-side; 429 → "slow down"), and delete-own via long-press. The
// counts/preview on the originating feed card stay in sync through the shared
// cache patches in @/lib/feed.
import { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ApiError } from '@twenty4/api-client';
import { COMMENT_MAX_LENGTH, type CommentDTO } from '@twenty4/contracts';
import { Avatar, Button, Input, Screen, Spinner, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { confirm } from '@/lib/confirm';
import { useAuthUser } from '@/stores/authStore';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { EmptyState, ErrorRetry, ListSkeleton } from '@/components/QueryState';
import { useAddComment, useComments, useDeleteComment } from '@/lib/feed';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return 'now';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function CommentRow({ comment, onDelete }: { comment: CommentDTO; onDelete: (c: CommentDTO) => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onLongPress={comment.canDelete ? () => onDelete(comment) : undefined}
      delayLongPress={350}
      testID={`comment-${comment.id}`}
      style={{ flexDirection: 'row', gap: theme.spacing.base, paddingVertical: theme.spacing.sm }}
    >
      <Avatar size="sm" uri={comment.author.avatarUrl ?? undefined} name={comment.author.displayName ?? 'Someone'} />
      <View style={{ flex: 1, gap: theme.spacing.xxs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="caption" color="primary" numberOfLines={1} style={{ flexShrink: 1 }}>
            {comment.author.displayName ?? 'Someone'}
          </Text>
          <Text variant="micro" color="faint">
            {timeAgo(comment.createdAt)}
          </Text>
        </View>
        <Text variant="body" color="secondary">
          {comment.text}
        </Text>
      </View>
    </Pressable>
  );
}

export default function CommentsScreen() {
  const theme = useTheme();
  const toast = useToast();
  const { montageId } = useLocalSearchParams<{ montageId: string }>();
  const user = useAuthUser();

  const commentsQuery = useComments(montageId);
  const addComment = useAddComment();
  const deleteComment = useDeleteComment();

  const [text, setText] = useState('');
  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= COMMENT_MAX_LENGTH && !addComment.isPending;

  const items: CommentDTO[] = commentsQuery.data?.pages.flatMap((p) => p.items) ?? [];

  const onSend = () => {
    if (!canSend || !user) return;
    addComment.mutate(
      {
        montageId,
        text: trimmed,
        author: { id: user.id, displayName: user.displayName, avatarUrl: user.profilePhotoUrl },
      },
      {
        onSuccess: () => setText(''),
        onError: (err) => {
          if (err instanceof ApiError && err.status === 429) {
            toast.show({ type: 'error', message: "You're commenting too fast — slow down a sec." });
          } else {
            toast.show({ type: 'error', message: 'Could not post your comment.' });
          }
        },
      },
    );
  };

  const onDelete = (c: CommentDTO) => {
    void confirm({ title: 'Delete comment?', confirmLabel: 'Delete' }).then((ok) => {
      if (!ok) return;
      deleteComment.mutate(
        { commentId: c.id, montageId },
        { onError: () => toast.show({ type: 'error', message: 'Could not delete comment.' }) },
      );
    });
  };

  const renderList = () => {
    if (commentsQuery.isLoading) {
      return <ListSkeleton count={4} />;
    }
    if (commentsQuery.isError) {
      return (
        <ErrorRetry
          onRetry={() => void commentsQuery.refetch()}
          error={commentsQuery.error}
          retrying={commentsQuery.isFetching}
        />
      );
    }
    if (items.length === 0) {
      return <EmptyState title="No comments yet" subtitle="Be the first to say something." />;
    }
    return (
      <FlatList
        testID="comments-list"
        data={items}
        keyExtractor={(it) => it.id}
        renderItem={({ item }) => <CommentRow comment={item} onDelete={onDelete} />}
        contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
        showsVerticalScrollIndicator={false}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (commentsQuery.hasNextPage && !commentsQuery.isFetchingNextPage) void commentsQuery.fetchNextPage();
        }}
        ListFooterComponent={
          commentsQuery.isFetchingNextPage ? (
            <View style={{ paddingVertical: theme.spacing.lg, alignItems: 'center' }}>
              <Spinner />
            </View>
          ) : null
        }
      />
    );
  };

  return (
    <Screen padded={false} keyboardAvoiding>
      <View style={{ flex: 1 }} testID="comments-screen">
        <View style={{ paddingHorizontal: theme.spacing.xl }}>
          <ScreenHeader title="Comments" />
        </View>

        <View style={{ flex: 1, paddingHorizontal: theme.spacing.xl }}>{renderList()}</View>

        {/* ── Composer (≤500 chars; counter; 429-aware) ───────────────────────── */}
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.base,
            paddingBottom: theme.spacing.base,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            gap: theme.spacing.sm,
          }}
        >
          <View testID="comment-input">
            <Input
              value={text}
              onChangeText={setText}
              placeholder="Add a comment…"
              maxLength={COMMENT_MAX_LENGTH}
              autoCapitalize="sentences"
              returnKeyType="send"
              onSubmitEditing={onSend}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="micro" color={text.length >= COMMENT_MAX_LENGTH ? 'danger' : 'faint'}>
              {text.length}/{COMMENT_MAX_LENGTH}
            </Text>
            <Button
              variant="primary"
              size="sm"
              title="Send"
              onPress={onSend}
              disabled={!canSend}
              loading={addComment.isPending}
              testID="comment-send"
            />
          </View>
        </View>
      </View>
    </Screen>
  );
}
