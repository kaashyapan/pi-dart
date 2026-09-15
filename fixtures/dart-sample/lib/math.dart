int add(int a, int b) => a + b;

/// Has one deliberate warning (unused local) so warning-only analyze runs are
/// observable without any errors.
String greeting(String name) {
  var unusedLocaleMarker = 1;
  return 'Hello, $name!';
}
