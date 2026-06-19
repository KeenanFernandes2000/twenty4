/**
 * 3.3 Comments — the comment thread for a recap. useComments INFINITE (cursor,
 * oldest-first): a list with each author + relative time, swipe-free delete on
 * the caller's own rows (and the montage owner can remove any), and a bottom
 * composer that optimistically appends. Add + delete are optimistic w/ rollback.
 *
 * Web-safe: the real query runs on a device; the web export renders the SAME
 * screen against lib/feedMocks so the orchestrator can screenshot it light/dark.
 */
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useLocalSearchParams } from 'expo-router';

import { useTheme } from '../../../../theme';
import { Avatar, EmptyState, Icon, Skeleton } from '../../../../ui';
import type { CommentResponse } from '@twenty4/contracts/dto';
import { timeAgo } from '../../../../features/feed/time';
import {
  useComments,
  flattenComments,
  useAddComment,
  useDeleteComment,
  useFeedCard,
} from '../../../../lib/feed';
import { useMe } from '../../../../lib/groups';
import { trackCommentSent } from '../../../../lib/analytics';
import { feedMockActive, mockComments, mockFeedCard } from '../../../../lib/feedMocks';

function CommentRow({
  comment,
  canDelete,
  onDelete,
}: {
  comment: CommentResponse;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const c = theme.colors;
  return (
    <View style={{ flexDirection: 'row', gap: 10, paddingVertical: theme.spacing.md }}>
      <Avatar name={comment.author.displayName} uri={comment.author.profilePhotoUrl ?? undefined} size={34} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...theme.typography.bodyStrong, color: c.text }}>{comment.author.displayName}</Text>
          <Text style={{ ...theme.typography.caption, color: c.muted }}>{timeAgo(comment.createdAt)}</Text>
          <View style={{ flex: 1 }} />
          {canDelete ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Delete comment" hitSlop={8} onPress={onDelete}>
              <Icon name="trash-outline" size={16} color={c.muted} />
            </Pressable>
          ) : null}
        </View>
        <Text style={{ ...theme.typography.body, color: c.text2, marginTop: 2 }}>{comment.text}</Text>
      </View>
    </View>
  );
}

export default function Comments() {
  const theme = useTheme();
  const c = theme.colors;
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const mock = feedMockActive();

  const cached = useFeedCard(id);
  const card = mock ? mockFeedCard(id) : cached;
  const me = useMe().data;
  const ownerId = card?.author.id;

  const query = useComments(id, { enabled: !mock });
  const add = useAddComment(id ?? '∅');
  const del = useDeleteComment(id ?? '∅');

  const comments = mock ? mockComments(id ?? '') : flattenComments(query.data);
  const [draft, setDraft] = useState('');

  const canDelete = useCallback(
    (cm: CommentResponse) =>
      (!!me && me.id === cm.author.id) || (!!me && me.id === ownerId),
    [me, ownerId],
  );

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (!mock) {
      add.mutate(text);
      // §12 comment_sent — montage id ONLY; the comment TEXT never leaves the device.
      if (id) trackCommentSent({ montageId: id });
    }
  }, [draft, mock, add, id]);

  const isLoading = !mock && query.isLoading;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: c.bg }}
      keyboardVerticalOffset={90}
    >
      <Stack.Screen options={{ title: 'Comments', presentation: 'modal' }} />

      {isLoading ? (
        <View style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <Skeleton width={34} height={34} radius={17} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton width={120} height={13} />
                <Skeleton width="80%" height={13} />
              </View>
            </View>
          ))}
        </View>
      ) : (
        <FlatList
          data={comments}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.sm,
            flexGrow: 1,
          }}
          renderItem={({ item }) => (
            <CommentRow
              comment={item}
              canDelete={canDelete(item)}
              onDelete={() => !mock && del.mutate(item.id)}
            />
          )}
          ItemSeparatorComponent={() => (
            <View style={{ height: 1, backgroundColor: c.border, marginLeft: 44 }} />
          )}
          onEndReached={() => {
            if (!mock && query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
          }}
          onEndReachedThreshold={0.4}
          ListEmptyComponent={
            <View style={{ flex: 1, justifyContent: 'center', minHeight: 360 }}>
              <EmptyState
                icon="chatbubbles-outline"
                title="No comments yet"
                body="Be the first to say something."
              />
            </View>
          }
          ListFooterComponent={
            query.isFetchingNextPage ? (
              <View style={{ paddingVertical: theme.spacing.md }}>
                <ActivityIndicator color={c.accent} />
              </View>
            ) : null
          }
        />
      )}

      {/* Composer */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 8,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.sm,
          paddingBottom: insets.bottom + theme.spacing.sm,
          borderTopWidth: 1,
          borderTopColor: c.border,
          backgroundColor: c.surface,
        }}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Add a comment…"
          placeholderTextColor={c.faint}
          multiline
          maxLength={500}
          style={{
            flex: 1,
            maxHeight: 100,
            backgroundColor: c.field,
            borderColor: c.border,
            borderWidth: 1,
            borderRadius: theme.radii.lg,
            paddingHorizontal: 14,
            paddingVertical: 10,
            color: c.text,
            fontFamily: theme.fontFamily.regular,
            fontSize: 15,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send comment"
          disabled={!draft.trim()}
          onPress={submit}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: draft.trim() ? c.accent : c.surface2,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <Icon name="arrow-up" size={22} color={draft.trim() ? c.onAccent : c.faint} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
