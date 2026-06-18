import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function ProfileSetup() {
  return (
    <>
      <Stack.Screen options={{ title: 'Your profile' }} />
      <Placeholder name="Profile setup (1.4)" icon="person-add-outline" description="Name, photo, handle." />
    </>
  );
}
