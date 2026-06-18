import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function Legal() {
  return (
    <>
      <Stack.Screen options={{ title: 'Terms & Privacy' }} />
      <Placeholder name="Legal (1.7)" icon="document-text-outline" description="Terms & privacy reader." />
    </>
  );
}
