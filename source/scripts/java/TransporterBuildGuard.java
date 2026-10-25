package com.mayou.upload;

import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.security.ProtectionDomain;
import org.objectweb.asm.*;

/**
 * Transporter 4.1's SoftwareUploader reuses the first build with a matching
 * CFBundleVersion, even across marketing versions. Supply the missing public
 * API filter before the request is built. Apple's jars stay unmodified.
 * Compiled for Java 11; runs on both bundled macOS and Windows runtimes.
 */
public final class TransporterBuildGuard {
    private static final String UPLOADER = "com/apple/transporter/software/builds/SoftwareUploader";
    private static final String BUILDER = "com/apple/transporter/iris/contentdelivery/api/BuildsApi$BuildsGetCollectionApiRequest$Builder";
    private static final String BUILD = "com/apple/transporter/iris/contentdelivery/model/Build";

    public static void premain(String args, Instrumentation instrumentation) {
        final String version = System.getenv("IPAUPLOAD_EXPECTED_VERSION");
        if (version == null || !version.matches("[0-9]+(\\.[0-9]+){0,2}")) {
            throw new IllegalArgumentException("Missing IPA marketing version for upload guard");
        }
        instrumentation.addTransformer(new ClassFileTransformer() {
            @Override public byte[] transform(ClassLoader loader, String name, Class<?> redefined,
                    ProtectionDomain domain, byte[] bytes) {
                if (!UPLOADER.equals(name)) return null;
                try { return instrument(bytes, version); }
                catch (Throwable error) {
                    // Throwing from a transformer alone lets Java load the original
                    // unsafe class. Stop this upload process instead.
                    System.err.println("ERROR: Upload version guard incompatible with Apple's component; upload stopped.");
                    Runtime.getRuntime().halt(78);
                    return null;
                }
            }
        });
    }

    public static byte[] instrument(byte[] bytes, String version) {
        ClassReader reader = new ClassReader(bytes);
        if (!UPLOADER.equals(reader.getClassName())) throw new IllegalArgumentException("Unexpected uploader class");
        ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_MAXS);
        final int[] changes = new int[2];
        reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
            @Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
                MethodVisitor next = super.visitMethod(access, name, descriptor, signature, exceptions);
                if ("findExistingBuild".equals(name)) return new MethodVisitor(Opcodes.ASM9, next) {
                    @Override public void visitMethodInsn(int opcode, String owner, String method, String desc, boolean isInterface) {
                        if (opcode == Opcodes.INVOKEVIRTUAL && BUILDER.equals(owner) && "build".equals(method) && desc.startsWith("()")) {
                            super.visitLdcInsn(version);
                            super.visitMethodInsn(Opcodes.INVOKESTATIC, "java/util/Collections", "singletonList", "(Ljava/lang/Object;)Ljava/util/List;", false);
                            super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, BUILDER, "filterPreReleaseVersionVersion", "(Ljava/util/List;)L" + BUILDER + ";", false);
                            super.visitFieldInsn(Opcodes.GETSTATIC, "java/lang/System", "out", "Ljava/io/PrintStream;");
                            super.visitLdcInsn("MSY_UPLOAD_VERSION_SCOPE=" + version);
                            super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/io/PrintStream", "println", "(Ljava/lang/String;)V", false);
                            changes[0]++;
                        }
                        super.visitMethodInsn(opcode, owner, method, desc, isInterface);
                    }
                };
                if ("complete".equals(name) && descriptor.startsWith("()")) return new MethodVisitor(Opcodes.ASM9, next) {
                    @Override public void visitCode() {
                        super.visitCode();
                        super.visitFieldInsn(Opcodes.GETSTATIC, "java/lang/System", "out", "Ljava/io/PrintStream;");
                        super.visitLdcInsn("MSY_UPLOAD_BUILD_ID=");
                        super.visitVarInsn(Opcodes.ALOAD, 0);
                        super.visitFieldInsn(Opcodes.GETFIELD, UPLOADER, "build", "L" + BUILD + ";");
                        super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, BUILD, "getId", "()Ljava/lang/String;", false);
                        super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/String", "concat", "(Ljava/lang/String;)Ljava/lang/String;", false);
                        super.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/io/PrintStream", "println", "(Ljava/lang/String;)V", false);
                        changes[1]++;
                    }
                };
                return next;
            }
        }, 0);
        if (changes[0] != 1 || changes[1] != 1) throw new IllegalStateException("Apple upload implementation changed");
        return writer.toByteArray();
    }
}
