import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function Welcome() {
  return (
    <>
      <Stack.Screen options={{ title: 'Welcome', headerShown: false }} />
      <Placeholder name="Welcome (1.1)" icon="sparkles-outline" description="Intro to twenty4." />
    </>
  );
}
