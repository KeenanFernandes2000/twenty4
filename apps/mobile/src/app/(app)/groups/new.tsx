// (app)/groups/new — Create a group. A single name field (1–80) + Create. On success
// we invalidate the groups list and replace into the new group's detail screen.
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '@twenty4/api-client';
import type { GroupDTO } from '@twenty4/contracts';
import { Button, Input, Screen, Text, useToast } from '@/ui';
import { useTheme } from '@/theme';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/lib/queryClient';
import { ScreenHeader } from '@/components/groups/ScreenHeader';

const MAX_NAME = 80;

export default function NewGroupScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');

  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_NAME;

  const createMutation = useMutation<GroupDTO, unknown, string>({
    mutationFn: (groupName) => api.createGroup({ name: groupName }),
    onSuccess: (group) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.list });
      router.replace(`/(app)/groups/${group.id}`);
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.code === 'VALIDATION_FAILED'
          ? 'That name isn’t valid. Use 1–80 characters.'
          : 'Could not create the group. Please try again.';
      toast.show({ type: 'error', message });
    },
  });

  const submit = () => {
    if (!valid || createMutation.isPending) return;
    createMutation.mutate(trimmed);
  };

  return (
    <Screen scroll keyboardAvoiding>
      <ScreenHeader title="New group" />
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.lg }}>
        <Text variant="body" color="muted">
          Give your group a name. You can change it later.
        </Text>

        <View testID="group-name-input">
          <Input
            label="Group name"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Weekend crew"
            autoCapitalize="words"
            autoFocus
            maxLength={MAX_NAME}
            returnKeyType="done"
            onSubmitEditing={submit}
          />
        </View>

        <Text variant="caption" color="faint" align="right">
          {trimmed.length}/{MAX_NAME}
        </Text>

        <Button
          variant="primary"
          fullWidth
          title="Create group"
          disabled={!valid}
          loading={createMutation.isPending}
          onPress={submit}
          testID="create-group-button"
        />
      </View>
    </Screen>
  );
}
