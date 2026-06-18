import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function Verify() {
  return (
    <>
      <Stack.Screen options={{ title: 'Verify' }} />
      <Placeholder name="Verify (1.3)" icon="keypad-outline" description="Enter the 6-digit code." />
    </>
  );
}
