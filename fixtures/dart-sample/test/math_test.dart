import 'package:test/test.dart';
import 'package:dart_sample/math.dart';

void main() {
  test('add works', () {
    expect(add(2, 3), equals(5));
  });

  test('intentionally failing', () {
    expect(add(1, 1), equals(3));
  });

  test('skipped placeholder', skip: 'not ready', () {
    expect(true, isTrue);
  });
}
